/**
 * Broadcast hub for a single player.
 *
 * Fans the live PCM of one player out to every subscribed HTTP listener.
 * Lifetime notes:
 * - One audio tap exists per decoded audio resource. Gapless playback and
 *   crossfades briefly create two taps for the same player, which is why
 *   listeners are *paused* (not closed) when the tap count drops to zero.
 * - When no tap and no listener remains, the broadcast removes itself from the
 *   registry, so `/{playerId}/stream` reports "not streaming" afterwards.
 */

import type { Buffer } from "node:buffer";
import { SharedOpusEncoder } from "./opus-encoder.ts";
import { StreamClient } from "./stream-client.ts";
import type {
  Logger,
  OpusEncoderConstructor,
  PluginSettings,
} from "./types.ts";

/** Collaborators required by {@link LiveBroadcast}. */
interface LiveBroadcastDeps {
  settings: PluginSettings;
  log: Logger;
  /** Resolves the NodeLink Opus `Encoder` class, or `null` when unavailable. */
  resolveEncoderClass: () => OpusEncoderConstructor | null;
  /** Reports whether the owning player still exists. */
  isPlayerAlive: () => boolean;
  /** Called when the broadcast has become unused and wants to be removed. */
  onDisposed: (broadcast: LiveBroadcast) => void;
}

/**
 * Fans one player's live audio out to every attached listener.
 */
export class LiveBroadcast {
  /** NodeLink player key (`sessionId:guildId`) the broadcast belongs to. */
  public readonly playerKey: string;

  /** Guild id owning the audio. */
  public readonly guildId: string;

  private readonly deps: LiveBroadcastDeps;
  private readonly clients = new Set<StreamClient>();
  private readonly encoder: SharedOpusEncoder;

  /** Number of live audio taps currently feeding this broadcast. */
  private taps = 0;

  /** Timer that verifies the player still exists. */
  private watchdogTimer: NodeJS.Timeout | null = null;

  /** Timer that sends an empty Ogg page while the player is idle. */
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** Frames forwarded since the broadcast was created. */
  private chunks = 0;

  /** Bytes forwarded since the broadcast was created. */
  private bytes = 0;

  /**
   * Creates a broadcast hub for a player.
   *
   * @param playerKey - NodeLink player key (`sessionId:guildId`).
   * @param guildId - Guild id owning the audio.
   * @param deps - Collaborators and lifecycle callbacks.
   */
  constructor(playerKey: string, guildId: string, deps: LiveBroadcastDeps) {
    this.playerKey = playerKey;
    this.guildId = guildId;
    this.deps = deps;

    this.encoder = new SharedOpusEncoder({
      settings: deps.settings,
      log: deps.log,
      resolveClass: deps.resolveEncoderClass,
      onPacket: (packet) => this.fanOut(packet),
      onFailure: () => this.endClients(),
    });
  }

  /**
   * Registers a newly created audio tap.
   */
  public addTap(): void {
    this.taps++;
    // Audio is flowing again, so the heartbeat is no longer needed.
    this.stopHeartbeat();
  }

  /**
   * Removes an audio tap, delivering the finished track's tail once the last
   * one goes away.
   */
  public removeTap(): void {
    this.taps = Math.max(0, this.taps - 1);
    if (this.taps !== 0) return;

    // Nothing is written while idle, so deliver the tail of the finished track
    // now instead of letting a partial page sit buffered until the next track.
    this.flushPartialPages();

    // Started after the tail flush so the heartbeat uses the final granule.
    this.startHeartbeat();
  }

  /**
   * Attaches an HTTP listener.
   *
   * @param client - Listener to attach.
   */
  public subscribe(client: StreamClient): void {
    this.clients.add(client);
    this.encoder.ensure();

    // Nothing has played yet: keep the connection warm from the start.
    if (this.taps === 0) this.startHeartbeat();

    // The stream is kept open from the moment it connects, so a client may
    // subscribe before any track starts.
    this.startWatchdog();
  }

  /**
   * Detaches an HTTP listener and disposes the broadcast when it becomes unused.
   *
   * @param client - Listener to detach.
   */
  public unsubscribe(client: StreamClient): void {
    this.clients.delete(client);

    if (this.clients.size === 0) {
      // Stop encoding as soon as nobody is listening.
      this.encoder.destroy();
      this.stopWatchdog();
      this.stopHeartbeat();
    }

    if (this.clients.size === 0 && this.taps === 0) this.dispose();
  }

  /**
   * Forwards a PCM frame from the player pipeline into the shared encoder.
   *
   * Nothing is written to listeners directly: every listener is fed from the
   * encoder output, so encoding happens once per broadcast regardless of how
   * many clients are attached.
   *
   * @param chunk - PCM frame emitted by the player pipeline.
   */
  public push(chunk: Buffer): void {
    this.chunks++;
    this.bytes += chunk.length;
    this.encoder.write(chunk);
  }

  /**
   * Gracefully ends every listener and removes the broadcast.
   */
  public close(): void {
    this.taps = 0;
    this.endClients();
  }

  /**
   * Builds a JSON-friendly description of the broadcast.
   *
   * @returns Diagnostic snapshot for the `/live` endpoint.
   */
  public describe(): Record<string, unknown> {
    let dropped = 0;
    for (const client of this.clients) dropped += client.dropped;

    return {
      playerId: this.playerKey,
      guildId: this.guildId,
      scope: "primary",
      active: this.taps > 0,
      idle: this.isIdle(),
      idleHeartbeatMs: this.deps.settings.idleHeartbeatMs,
      taps: this.taps,
      listeners: this.clients.size,
      opusEncoding: this.encoder.active,
      droppedFrames: dropped,
      chunks: this.chunks,
      bytes: this.bytes,
    };
  }

  /**
   * Reports whether the broadcast currently has no audio to send.
   *
   * A live tap exists exactly while an audio resource is alive, so the tap count
   * is the authoritative signal. While idle nothing is written at all.
   *
   * @returns `true` when nothing is playing.
   */
  private isIdle(): boolean {
    return this.taps === 0;
  }

  /**
   * Delivers buffered (partial) Opus pages to every listener.
   *
   * Called when playback stops, so the finished track's tail is not stranded in
   * the pager until the next track starts.
   */
  private flushPartialPages(): void {
    for (const client of Array.from(this.clients)) {
      const page = client.partialPage();
      if (!page) continue;

      // A listener that is already gone keeps its buffered packet; it is being
      // torn down anyway.
      if (client.isUnusable) continue;
      if (!client.write(page)) this.clients.delete(client);
    }
  }

  /**
   * Fans one encoded Opus packet out to every listener.
   *
   * @param packet - Encoded Opus packet produced by the shared encoder.
   */
  private fanOut(packet: Buffer): void {
    if (this.clients.size === 0) {
      this.encoder.destroy();
      return;
    }

    for (const client of Array.from(this.clients)) {
      if (client.isUnusable) {
        this.clients.delete(client);
        continue;
      }

      if (client.isBackpressured) {
        client.noteDrop();
        continue;
      }

      const page = client.encodePacket(packet);
      if (!page) continue;
      if (!client.write(page)) this.clients.delete(client);
    }

    if (this.clients.size === 0) this.encoder.destroy();
  }

  /**
   * Starts the idle heartbeat.
   *
   * While the player produces no audio, one empty Ogg page is written per
   * interval so a proxy or client with an idle read timeout has something to
   * read. The page carries no segments, so the audio timeline is untouched and
   * the cost is ~2 B/s instead of ~12.4 kB/s for real silence.
   *
   * Disabled by `idleHeartbeatMs: 0`, and pointless without a listener.
   */
  private startHeartbeat(): void {
    const interval = this.deps.settings.idleHeartbeatMs;
    if (interval <= 0 || this.heartbeatTimer) return;
    if (this.taps > 0 || this.clients.size === 0) return;

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), interval);
    this.heartbeatTimer.unref?.();
  }

  /** Writes one heartbeat page, stopping the timer once it is not applicable. */
  private sendHeartbeat(): void {
    // Playback resumed or everybody left. The tap teardown and disconnect
    // handlers re-arm it if the situation returns.
    if (this.taps > 0 || this.clients.size === 0) {
      this.stopHeartbeat();
      return;
    }

    for (const client of Array.from(this.clients)) {
      if (client.isUnusable) continue;
      client.writeHeartbeat();
    }
  }

  /** Stops the idle heartbeat. */
  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * Starts the watchdog that closes the stream once the player is gone.
   *
   * The broadcast already reacts immediately to playback stopping, because the
   * tap teardown flushes the pager. This is only a backstop for a player that
   * disappears without the tap being destroyed.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;

    this.watchdogTimer = setInterval(
      () => this.checkPlayerAlive(),
      this.deps.settings.playerCheckMs,
    );
    this.watchdogTimer.unref?.();
  }

  /** Stops the player watchdog. */
  private stopWatchdog(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /**
   * Closes the stream when its player no longer exists.
   *
   * The stream lives exactly as long as the player: an empty queue keeps it
   * open (sending nothing), but a destroyed player ends it.
   */
  private checkPlayerAlive(): void {
    if (this.deps.isPlayerAlive()) return;

    this.deps.log(
      `Player ${this.playerKey} no longer exists; closing ` +
        `${this.clients.size} live stream listener(s).`,
    );
    this.endClients();
  }

  /**
   * Gracefully ends every listener and disposes the broadcast.
   */
  private endClients(): void {
    this.stopWatchdog();
    this.stopHeartbeat();

    for (const client of Array.from(this.clients)) {
      client.closeStream();
    }

    this.clients.clear();
    this.encoder.destroy();
    this.dispose();
  }

  /** Removes the broadcast from its registry. */
  private dispose(): void {
    this.stopWatchdog();
    this.stopHeartbeat();
    this.deps.onDisposed(this);
  }
}
