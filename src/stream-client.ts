/**
 * One HTTP listener attached to a broadcast.
 *
 * Owns the response socket, the listener's Ogg Opus pager via parent
 * `OggOpusPager` and all of the failure bookkeeping, so the broadcast never has
 * to touch response internals directly.
 */

import type { Buffer } from "node:buffer";
import type { ServerResponse } from "node:http";
import { AUDIO_CONTENT_TYPE, SOCKET_KEEPALIVE_MS } from "./constants.ts";
import { OggOpusPager } from "./ogg.ts";
import { flushHeaders } from "./responses.ts";

/** Construction options for a {@link StreamClient}. */
interface StreamClientOptions {
  /** Opus packets per emitted Ogg page. */
  pagePackets: number;
  /** Response write-buffer ceiling before frames are dropped. */
  maxBufferBytes: number;
}

/**
 * A single listener's view of a live stream.
 */
export class StreamClient {
  private readonly res: ServerResponse;
  private readonly pager: OggOpusPager;
  private readonly maxBufferBytes: number;
  private droppedFrames = 0;
  private headersSent = false;
  private closed = false;

  /**
   * Creates a listener wrapper.
   *
   * @param res - Response to stream into.
   * @param options - Pager and buffer sizing.
   */
  constructor(res: ServerResponse, options: StreamClientOptions) {
    this.res = res;
    this.pager = new OggOpusPager(options.pagePackets);
    this.maxBufferBytes = options.maxBufferBytes;
  }

  /** Frames skipped because this listener could not keep up. */
  public get dropped(): number {
    return this.droppedFrames;
  }

  /** Reports whether this listener has been detached or has failed. */
  public get isClosed(): boolean {
    return this.closed;
  }

  /** Reports whether the response can no longer receive writes. */
  public get isUnusable(): boolean {
    return this.closed || this.res.destroyed || this.res.writableEnded;
  }

  /** Reports whether the listener is too far behind to accept another frame. */
  public get isBackpressured(): boolean {
    return this.res.writableLength > this.maxBufferBytes;
  }

  /** Records a frame dropped due to backpressure. */
  public noteDrop(): void {
    this.droppedFrames++;
  }

  /**
   * Writes the streaming headers and the Ogg Opus preamble.
   *
   * Idempotent: only the first call has an effect. The stream is opened
   * immediately, so a client may attach before any track starts.
   */
  public open(): void {
    if (this.headersSent) return;
    this.headersSent = true;

    if (this.isUnusable) {
      this.closed = true;
      return;
    }

    this.res.writeHead(200, {
      "content-type": AUDIO_CONTENT_TYPE,
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    // Disable Nagle's algorithm. Opus pages are small (~200 B) and are written
    // one at a time; with Nagle plus delayed ACK a writer can stall for tens to
    // hundreds of milliseconds, which shows up as periodic stutter. Node's HTTP
    // server already defaults this to true, but being explicit removes a real
    // latency class for this traffic pattern.
    try {
      this.res.socket?.setNoDelay(true);
    } catch {
      // Socket may be unavailable on alternate response implementations.
    }

    // Nothing is sent while idle, so the socket can be quiet for minutes. TCP
    // keepalive probes stop NAT/proxy idle timeouts from silently dropping the
    // connection, at a few bytes per probe instead of continuous audio.
    try {
      this.res.socket?.setKeepAlive(true, SOCKET_KEEPALIVE_MS);
    } catch {
      // Socket may be unavailable on alternate response implementations.
    }

    // Push the headers out immediately so clients can start buffering before
    // the first audio page arrives (players may be paused or mid-transition).
    flushHeaders(this.res);

    // `OpusHead` (BOS) and `OpusTags` must precede any audio page.
    for (const page of this.pager.headerPages()) this.res.write(page);
  }

  /**
   * Registers disconnect handling for the underlying socket.
   *
   * @param handler - Invoked once when the client goes away.
   */
  public onDisconnect(handler: () => void): void {
    let notified = false;
    const notify = (): void => {
      if (notified) return;
      notified = true;
      handler();
    };

    this.res.on("close", notify);
    this.res.on("error", notify);
  }

  /**
   * Writes bytes to the listener.
   *
   * Never throws: a failed write marks the listener closed so the broadcast can
   * drop it on the next pass.
   *
   * @param data - Serialized page.
   * @returns `true` when the bytes were queued.
   */
  public write(data: Buffer): boolean {
    if (this.isUnusable) return false;

    try {
      this.res.write(data);
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  /**
   * Queues an encoded packet, yielding a page once enough have accumulated.
   *
   * @param packet - Encoded Opus packet.
   * @returns The page to send, or `null`.
   */
  public encodePacket(packet: Buffer): Buffer | null {
    return this.pager.pushPacket(packet);
  }

  /**
   * Drains buffered packets into a normal (non-EOS) page.
   *
   * @returns The page, or `null` when nothing is buffered.
   */
  public partialPage(): Buffer | null {
    return this.pager.flushPartial();
  }

  /**
   * Writes an idle heartbeat page, if one can be sent right now.
   *
   * Best effort: nothing is written when the socket is gone or the listener is
   * behind, because the heartbeat is a courtesy to intermediaries rather than
   * part of the audio timeline. Deliberately returns nothing - "could not write"
   * covers both a failed socket and a legitimately skipped page, and the caller
   * must not treat the latter as an error.
   */
  public writeHeartbeat(): void {
    if (this.isUnusable || this.isBackpressured) return;

    const page = this.pager.keepAlivePage();
    if (page) this.write(page);
  }

  /**
   * Ends the Ogg bitstream cleanly and finishes the response.
   */
  public closeStream(): void {
    try {
      // A listener that never received a single page still needs headers, or
      // the client would see a connection close without a response.
      this.open();

      // Close the Ogg bitstream cleanly so players can finalize the stream.
      for (const page of this.pager.flush()) this.res.write(page);
      if (!this.res.writableEnded) this.res.end();
    } catch {
      // The socket is already gone; nothing to do.
    }
  }

  /** Marks the listener as detached, preventing a second teardown. */
  public markDetached(): void {
    this.closed = true;
  }
}
