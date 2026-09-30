/**
 * Public API surface.
 *
 * Registered as a NodeLink middleware, which runs before routing and before the
 * core 404 handler; returning `true` short-circuits both.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isPlayerKey,
  LIST_PATH,
  OPUS_FRAMES_PER_SECOND,
  STREAM_PATH,
} from "./constants.ts";
import { readServerPassword } from "./node-link.ts";
import { sendJson, sendText } from "./responses.ts";
import { proxyToWorker, waitForOffer } from "./cluster-relay.ts";
import type { BroadcastRegistry } from "./broadcast-registry.ts";
import type { PlayerDirectory } from "./player-directory.ts";
import type { WorkerOfferRegistry } from "./cluster-relay.ts";
import type {
  Logger,
  MiddlewareHandler,
  NodelinkLike,
  PluginSettings,
  RouteMatch,
} from "./types.ts";

/**
 * Matches a request path against the plugin's routes.
 *
 * @param pathname - Path portion of the request URL.
 * @returns The matched route, or `null` when the plugin does not own it.
 */
function matchRoute(pathname: string): RouteMatch | null {
  if (LIST_PATH.test(pathname)) return { kind: "list" };

  const stream = STREAM_PATH.exec(pathname);
  if (stream) return { kind: "stream", playerId: (stream[1] ?? "").trim() };

  return null;
}

/** Collaborators required by {@link ApiHandler}. */
interface ApiHandlerDeps {
  settings: PluginSettings;
  log: Logger;
  registry: BroadcastRegistry;
  directory: PlayerDirectory;
  offers: WorkerOfferRegistry;
  /** Reports whether Opus output can be produced in this process. */
  canEncode: () => boolean;
}

/**
 * Serves the public live-stream endpoints.
 */
export class ApiHandler {
  private readonly deps: ApiHandlerDeps;

  /**
   * Creates a handler.
   *
   * @param deps - Collaborators.
   */
  constructor(deps: ApiHandlerDeps) {
    this.deps = deps;
  }

  /**
   * Builds the middleware NodeLink should invoke for every request.
   *
   * @returns The middleware callback.
   */
  public middleware(): MiddlewareHandler {
    return (nodelink, req, res, parsedUrl) =>
      this.handle(nodelink, req, res, parsedUrl);
  }

  /**
   * Handles a request.
   *
   * @param nodelink - NodeLink instance of the primary.
   * @param req - Incoming request.
   * @param res - Outgoing response.
   * @param parsedUrl - Parsed request URL.
   * @returns `true` when the request was handled.
   */
  public async handle(
    nodelink: NodelinkLike,
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: URL,
  ): Promise<boolean> {
    const match = matchRoute(parsedUrl.pathname);
    if (!match) return false;

    const method = String(req.method ?? "GET").toUpperCase();
    // `/live` also answers HEAD; a stream is GET-only.
    const allowed =
      match.kind === "list"
        ? method === "GET" || method === "HEAD"
        : method === "GET";

    if (!allowed) {
      sendJson(res, 405, { error: `Method ${method} is not allowed here` });
      return true;
    }

    if (!this.isAuthorized(nodelink, req)) {
      sendText(res, 401, "Unauthorized");
      return true;
    }

    if (match.kind === "list") {
      this.listPlayers(res, method === "HEAD");
      return true;
    }

    const playerId = match.playerId;

    // Only a fully qualified `sessionId:guildId` key is accepted. A bare guild
    // id is ambiguous whenever more than one session plays in that guild (two
    // bot instances sharing a server), so resolving one would be a coin flip.
    if (!isPlayerKey(playerId)) {
      sendJson(res, 400, {
        error: "A fully qualified player id is required (sessionId:guildId)",
        playerId,
        hint: "Use the playerId reported by GET /live",
      });
      return true;
    }

    const target = this.deps.directory.resolveTarget(playerId);

    if (!target) {
      sendJson(res, 404, {
        error: "No active player for the requested id",
        playerId,
        hint: "Check GET /live for the list of streamable players",
      });
      return true;
    }

    // Opus is encoded in the process that owns the player. When players live in
    // workers the worker validates instead and reports its own error through the
    // proxy, so only reject early for locally hosted players.
    if (target.workerId === null && !this.deps.canEncode()) {
      sendJson(res, 503, {
        error: "Opus encoding is unavailable in this process",
        hint: "Check the plugin logs; a compatible Opus library may be missing",
      });
      return true;
    }

    if (target.workerId === null) {
      this.deps.registry.attach(target.playerKey, res);
      return true;
    }

    const offer = await waitForOffer(
      this.deps.directory,
      this.deps.offers,
      target.workerId,
    );

    if (!offer) {
      this.deps.log(
        `Worker ${target.workerId} has no live tap endpoint for ${target.playerKey}`,
        "warn",
      );
      sendJson(res, 503, {
        error: "The worker hosting this player is not tap-ready yet",
        playerKey: target.playerKey,
        workerId: target.workerId,
      });
      return true;
    }

    proxyToWorker(offer, target.playerKey, res);
    return true;
  }

  /**
   * Verifies the caller against `server.password`, mirroring the core rules.
   *
   * The password is always required: these endpoints expose live audio, so they
   * are never served to an unauthenticated caller.
   *
   * @param nodelink - NodeLink instance of the primary.
   * @param req - Incoming request.
   * @returns `true` when the request may continue.
   */
  private isAuthorized(nodelink: NodelinkLike, req: IncomingMessage): boolean {
    const password = readServerPassword(nodelink);
    if (!password) return true;

    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;

    return value === password || value === `Bearer ${password}`;
  }

  /**
   * Handles the JSON overview of streamable players.
   *
   * @param res - Client response.
   * @param headOnly - Whether the request was a `HEAD`.
   */
  private listPlayers(res: ServerResponse, headOnly: boolean): void {
    const players: Record<string, unknown>[] = [];
    const table = this.deps.directory.guildToWorker();

    if (table) {
      for (const [key, workerId] of table) {
        const pid = this.deps.directory.workerPid(workerId);
        const offer = pid === null ? undefined : this.deps.offers.get(pid);

        players.push({
          playerId: String(key),
          guildId: this.deps.directory.guildOf(String(key)),
          workerId,
          scope: "worker",
          // With keep-alive a player stays streamable for as long as it exists,
          // so a reachable tap endpoint is enough to serve it. Whether it is
          // currently *playing* is reported by the worker through the relay.
          tapReady: Boolean(offer),
          idle: !offer,
        });
      }
    } else {
      // Include players that exist but have no broadcast yet (nothing has ever
      // played, or playback ended): with keep-alive they are still streamable.
      const described = new Set<string>();

      for (const broadcast of this.deps.registry.values()) {
        described.add(broadcast.playerKey);
        players.push(broadcast.describe());
      }

      for (const [key, player] of this.deps.directory.listLocal()) {
        if (described.has(key)) continue;

        players.push({
          playerId: key,
          guildId: this.deps.directory.guildOf(key),
          scope: "primary",
          active: false,
          idle: true,
          idleHeartbeatMs: this.deps.settings.idleHeartbeatMs,
          listeners: 0,
          playing: Boolean((player as { track?: unknown }).track),
        });
      }
    }

    sendJson(
      res,
      200,
      {
        count: players.length,
        players,
        endpoint: "/{sessionId}:{guildId}/stream",
        format: {
          label: "Ogg Opus",
          contentType: "audio/ogg",
          targetBitrate: this.deps.settings.opusBitrate,
          framesPerSecond: OPUS_FRAMES_PER_SECOND,
          packetsPerPage: this.deps.settings.opusPagePackets,
          bytesPerSecond: Math.round(this.deps.settings.opusBitrate / 8),
          available: this.deps.canEncode(),
        },
      },
      headOnly,
    );
  }
}
