/**
 * Configuration normalization for the Live Stream plugin.
 */

import type { LiveStreamConfig, PluginSettings } from "./types.ts";

/** Settings used when the operator provides no configuration. */
const DEFAULTS: PluginSettings = {
  bindHost: "127.0.0.1",
  playerCheckMs: 5000,
  idleHeartbeatMs: 15000,
  maxClientBufferBytes: 512 * 1024,
  announceIntervalMs: 20000,
  opusBitrate: 96000,
  opusPagePackets: 4,
};

/**
 * Coerces a configuration value into a finite integer of at least `min`.
 *
 * @param value - Candidate value.
 * @param fallback - Value used when `value` is unusable.
 * @param min - Smallest accepted value; pass `0` for options where `0` is a
 *   meaningful "disabled" rather than an invalid value.
 * @returns A finite integer, never below `min`.
 */
function int(value: unknown, fallback: number, min = 1): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min
    ? Math.floor(parsed)
    : fallback;
}

/**
 * Merges an operator configuration block over the defaults.
 *
 * Always returns a fresh object, so repeated loads cannot leak settings between
 * processes.
 *
 * @param config - Raw `pluginConfig["live-stream"]` block.
 * @returns The normalized settings.
 */
export function normalizeSettings(
  config: LiveStreamConfig | undefined,
): PluginSettings {
  const c = config ?? {};
  const host = typeof c.bindHost === "string" ? c.bindHost.trim() : "";

  return {
    bindHost: host || DEFAULTS.bindHost,
    playerCheckMs: int(c.playerCheckMs, DEFAULTS.playerCheckMs),
    // `0` disables the heartbeat, so it is an allowed value.
    idleHeartbeatMs: int(c.idleHeartbeatMs, DEFAULTS.idleHeartbeatMs, 0),
    maxClientBufferBytes: int(
      c.maxClientBufferBytes,
      DEFAULTS.maxClientBufferBytes,
    ),
    announceIntervalMs: int(c.announceIntervalMs, DEFAULTS.announceIntervalMs),
    opusBitrate: int(c.opusBitrate, DEFAULTS.opusBitrate),
    opusPagePackets: int(c.opusPagePackets, DEFAULTS.opusPagePackets),
  };
}
