/**
 * Shared Opus encoder lifecycle.
 *
 * One encoder exists per broadcast while at least one listener is attached, so
 * encoding cost stays independent of listener count. The encoder is the only
 * component that turns PCM into Opus packets, which makes it the natural owner
 * of the backpressure policy that protects playback from slow listeners.
 */

import type { Buffer } from "node:buffer";
import { Transform } from "node:stream";
import { CHANNELS, OPUS_FRAME_SAMPLES, SAMPLE_RATE } from "./constants.ts";
import type {
  Logger,
  OpusEncoderConstructor,
  PluginSettings,
} from "./types.ts";

/** Collaborators required by {@link SharedOpusEncoder}. */
interface SharedOpusEncoderDeps {
  settings: PluginSettings;
  log: Logger;
  /** Resolves the NodeLink `Encoder` class, or `null` when unavailable. */
  resolveClass: () => OpusEncoderConstructor | null;
  /** Receives each encoded packet. */
  onPacket: (packet: Buffer) => void;
  /** Invoked once when the encoder becomes unusable. */
  onFailure: (error: Error) => void;
}

/**
 * Wraps a NodeLink Opus encoder with lazy creation and a drop-on-overflow
 * policy.
 */
export class SharedOpusEncoder {
  private readonly deps: SharedOpusEncoderDeps;
  private encoder: Transform | null = null;
  private failed = false;

  /**
   * Creates an encoder wrapper.
   *
   * @param deps - Collaborators and callbacks.
   */
  constructor(deps: SharedOpusEncoderDeps) {
    this.deps = deps;
  }

  /** Reports whether an encoder instance is currently alive. */
  public get active(): boolean {
    return this.encoder !== null;
  }

  /**
   * Creates the encoder if it is needed and available.
   */
  public ensure(): void {
    if (this.encoder || this.failed) return;

    const EncoderClass = this.deps.resolveClass();
    if (!EncoderClass) return;

    let encoder: Transform;
    try {
      encoder = new EncoderClass({
        rate: SAMPLE_RATE,
        channels: CHANNELS,
        frameSize: OPUS_FRAME_SAMPLES,
        application: "audio",
      }) as Transform;
    } catch (err) {
      this.fail(err as Error, "create");
      return;
    }

    const controls = encoder as unknown as {
      setBitrate?: (value: number) => void;
      setDTX?: (enabled: boolean) => void;
    };

    try {
      controls.setBitrate?.(this.deps.settings.opusBitrate);
      // DTX would suppress packets during quiet passages, which would break the
      // granule accounting the Ogg pages depend on.
      controls.setDTX?.(false);
    } catch {
      // Control failures are non-fatal; the encoder keeps its defaults.
    }

    encoder.on("data", (packet: Buffer) => this.deps.onPacket(packet));
    encoder.on("error", (err: Error) => this.fail(err, "runtime"));

    this.encoder = encoder;
  }

  /**
   * Feeds PCM into the encoder.
   *
   * Frames are dropped when the encoder is behind. Dropping beats buffering:
   * blocking here would stall the tap and therefore Discord playback as well.
   *
   * @param chunk - PCM frame emitted by the player pipeline.
   */
  public write(chunk: Buffer): void {
    const encoder = this.encoder;
    if (!encoder) return;

    if (encoder.writableLength > this.deps.settings.maxClientBufferBytes)
      return;

    try {
      encoder.write(chunk);
    } catch (err) {
      this.fail(err as Error, "runtime");
    }
  }

  /**
   * Drops the encoder, releasing the native Opus instance.
   */
  public destroy(): void {
    const encoder = this.encoder;
    if (!encoder) return;

    this.encoder = null;
    try {
      encoder.removeAllListeners("data");
    } catch {
      // Nothing to detach.
    }

    // Destroying synchronously from inside the encoder's own `data` handler
    // would re-enter the stream, so defer it.
    setImmediate(() => {
      try {
        encoder.destroy();
      } catch {
        // Already destroyed.
      }
    });
  }

  /**
   * Reports an encoder failure, disabling further encoding.
   *
   * @param err - Error that broke the encoder.
   * @param phase - Whether the failure happened while creating or using it.
   */
  private fail(err: Error, phase: "create" | "runtime"): void {
    if (this.failed) return;
    this.failed = true;

    this.deps.log(
      phase === "create"
        ? `Failed to create the Opus encoder: ${err.message}`
        : `Opus encoder error: ${err.message}`,
      "error",
    );

    this.destroy();
    this.deps.onFailure(err);
  }
}
