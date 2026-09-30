/**
 * Shared types for the NodeLink Live Stream plugin.
 *
 * This module intentionally imports nothing from the rest of the plugin so it
 * can be depended on from anywhere without creating an import cycle.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Loosely typed view of the NodeLink instance passed to a plugin. */
export type NodelinkLike = Record<string, unknown>;

/** Minimal logger signature handed to every collaborator. */
export type Logger = (message: string, level?: string) => void;

/** Signature of `nodelink.logger` itself. */
export type ServerLogger = (
  level: string,
  module: string,
  message: string,
) => void;

/** Raw plugin configuration as provided by the operator. */
export interface LiveStreamConfig {
  /** Interface the internal tap endpoint binds to. Defaults to `127.0.0.1`. */
  bindHost?: string;
  /**
   * How often to verify the player still exists. Defaults to `5000`.
   *
   * A stream lives exactly as long as its player, so this is the backstop that
   * closes one whose player disappeared without the audio tap being torn down.
   */
  playerCheckMs?: number;
  /**
   * Milliseconds between idle heartbeat pages. Defaults to `15000`.
   *
   * While no audio is flowing the plugin writes one empty Ogg page per interval.
   * The page carries no segments and does not advance the granule timeline, so a
   * client decodes exactly the same audio - it only gives a proxy or client with
   * an idle read timeout something to read, at ~2 B/s instead of the ~12.4 kB/s
   * real silence would cost.
   *
   * Set to `0` to send nothing at all while idle.
   */
  idleHeartbeatMs?: number;
  /** Per-listener write buffer ceiling; frames are dropped above it. */
  maxClientBufferBytes?: number;
  /** How often workers re-advertise their tap endpoint. */
  announceIntervalMs?: number;
  /** Target bitrate in bit/s. Defaults to `96000`. */
  opusBitrate?: number;
  /** Opus packets per Ogg page (each packet is 20 ms). Defaults to `4`. */
  opusPagePackets?: number;
}

/** Normalized plugin configuration. */
export interface PluginSettings {
  bindHost: string;
  playerCheckMs: number;
  idleHeartbeatMs: number;
  maxClientBufferBytes: number;
  announceIntervalMs: number;
  opusBitrate: number;
  opusPagePackets: number;
}

/**
 * Signature accepted by `nodelink.registerMiddleware`.
 *
 * Returning `true` short-circuits the core router.
 */
export type MiddlewareHandler = (
  nodelink: NodelinkLike,
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
) => Promise<boolean> | boolean;

/** Constructor shape of the NodeLink playback `Encoder` class. */
export type OpusEncoderConstructor = new (options: {
  rate?: number;
  channels?: number;
  frameSize?: number;
  application?: string;
}) => unknown;

/** Player attribution captured for a single player operation. */
export interface TapContext {
  /** Full player key (`sessionId:guildId`). */
  playerKey: string;
  guildId: string;
  player: Record<string, unknown> | null;
}

/** Where a player's audio is hosted and how to reach it. */
export interface StreamTarget {
  playerKey: string;
  /** Worker id when clustered, `null` when the primary hosts the player. */
  workerId: number | null;
}

/** Tap endpoint advertised by a playback worker. */
export interface WorkerOffer {
  pid: number;
  port: number;
  token: string;
  lastSeen: number;
}

/**
 * Result of matching a request path against the plugin's routes.
 *
 * The plugin only serves `GET /live` and `GET /{sessionId}:{guildId}/stream`
 * (each with an optional `v4/` prefix), so a stream match always carries the
 * player key from the path.
 */
export type RouteMatch =
  | { kind: "list" }
  | { kind: "stream"; playerId: string };

/** Plugin execution context as reported by NodeLink. */
export interface PluginContext {
  type?: string;
}
