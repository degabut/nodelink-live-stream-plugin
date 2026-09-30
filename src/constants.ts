/**
 * Shared constants for the NodeLink Live Stream plugin.
 *
 * Kept free of imports so every other module can depend on this one without
 * risking a cycle.
 */

/** Name used for log lines and for `pluginConfig` lookups. */
export const PLUGIN_NAME = "live-stream";

/** IPC message type a playback worker uses to advertise its local tap endpoint. */
export const OFFER_MESSAGE = "nodelink.live-stream.offer";

/** IPC message type the primary sends to ask the workers to re-advertise. */
export const ANNOUNCE_MESSAGE = "nodelink.live-stream.announce";

/** Header used to authenticate primary -> worker tap requests. */
export const TOKEN_HEADER = "x-live-stream-token";

/** Sample rate produced by the NodeLink playback pipeline. */
export const SAMPLE_RATE = 48000;

/** Channel count produced by the NodeLink playback pipeline. */
export const CHANNELS = 2;

/** Vendor string written into the `OpusTags` comment header. */
export const OPUS_VENDOR = "NodeLink live-stream";

/** Samples libopus discards at the start of a stream (6.5 ms at 48 kHz). */
export const OPUS_PRESKIP = 312;

/** Samples per encoded Opus packet (20 ms at 48 kHz). */
export const OPUS_FRAME_SAMPLES = 960;

/** Opus frames produced per second, derived from the frame size. */
export const OPUS_FRAMES_PER_SECOND = SAMPLE_RATE / OPUS_FRAME_SAMPLES;

/**
 * Readable buffer ceiling for the audio tap.
 *
 * Matches NodeLink's own `AUDIO_CONFIG.highWaterMark` in `streamProcessor.ts`.
 * Matching the rest of the pipeline keeps the tap transparent: backpressure is
 * propagated upstream at exactly the same point it would be without the tap, so
 * the tap never absorbs extra PCM or delays regulation of the source download.
 */
export const TAP_HIGH_WATER_MARK = 19200;

/**
 * Ogg page header-type flags: `bos` opens the bitstream, `eos` ends it.
 */
export const OGG_HEADER = {
  bos: 0x02,
  eos: 0x04,
} as const;

/** How long to wait for a worker's tap endpoint before giving up. */
export const WORKER_OFFER_WAIT_MS = 2000;

/** Poll interval used while waiting for a worker's tap endpoint. */
export const WORKER_OFFER_POLL_MS = 100;

/** Multiplier applied to `announceIntervalMs` before an offer is stale. */
export const OFFER_STALE_MULTIPLIER = 3;

/** Socket keepalive delay, in milliseconds. */
export const SOCKET_KEEPALIVE_MS = 15000;

/** `GET /{sessionId}:{guildId}/stream`, with an optional `v4/` prefix. */
export const STREAM_PATH = /^\/(?:v4\/)?([^/]{1,128})\/stream$/;

/**
 * A fully qualified player key: `sessionId:guildId`.
 *
 * A player is only ever addressed by this exact key. A bare guild id cannot be
 * resolved unambiguously - several sessions (for example two bot instances)
 * may play in the same guild at the same time - so it is rejected instead of
 * being guessed at.
 */
const PLAYER_KEY_PATTERN = /^[^:/]{1,64}:[^:/]{1,64}$/;

/**
 * Reports whether an id is a fully qualified `sessionId:guildId` player key.
 *
 * @param value - Candidate player id.
 * @returns `true` when the value carries both a session and a guild.
 */
export function isPlayerKey(value: string): boolean {
  return PLAYER_KEY_PATTERN.test(value);
}

/** `GET /live`, with an optional `v4/` prefix. */
export const LIST_PATH = /^\/(?:v4\/)?live\/?$/;

/** Content type served for every audio response. */
export const AUDIO_CONTENT_TYPE = "audio/ogg";
