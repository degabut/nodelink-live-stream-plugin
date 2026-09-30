/**
 * Cluster relay.
 *
 * When NodeLink runs clustered, players live in playback workers. Each worker
 * binds a loopback-only tap endpoint, advertises it to the primary over IPC, and
 * the primary proxies `GET /{playerId}/stream` to it.
 */

import { randomBytes } from "node:crypto";
import cluster from "node:cluster";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  ANNOUNCE_MESSAGE,
  isPlayerKey,
  OFFER_MESSAGE,
  OFFER_STALE_MULTIPLIER,
  TOKEN_HEADER,
  WORKER_OFFER_POLL_MS,
  WORKER_OFFER_WAIT_MS,
} from "./constants.ts";
import { delay } from "./node-link.ts";
import { flushHeaders, sendJson, sendText } from "./responses.ts";
import type { PlayerDirectory } from "./player-directory.ts";
import type { BroadcastRegistry } from "./broadcast-registry.ts";
import type { Logger, PluginSettings, WorkerOffer } from "./types.ts";

/**
 * Tap endpoints advertised by playback workers.
 */
export class WorkerOfferRegistry {
  private readonly offers = new Map<number, WorkerOffer>();
  private readonly staleAfterMs: number;

  /**
   * Creates a registry.
   *
   * @param staleAfterMs - Age after which an offer is considered abandoned.
   */
  constructor(staleAfterMs: number) {
    this.staleAfterMs = staleAfterMs;
  }

  /** Number of known workers. */
  public get size(): number {
    return this.offers.size;
  }

  /**
   * Looks up a worker's endpoint.
   *
   * @param pid - Worker process id.
   * @returns The offer, or `undefined` when unknown.
   */
  public get(pid: number): WorkerOffer | undefined {
    return this.offers.get(pid);
  }

  /**
   * Records an endpoint advertisement.
   *
   * @param offer - Advertised endpoint.
   * @returns `true` when the worker had not advertised before.
   */
  public remember(offer: WorkerOffer): boolean {
    const isNew = !this.offers.has(offer.pid);
    this.offers.set(offer.pid, offer);
    this.prune();
    return isNew;
  }

  /**
   * Drops endpoints that stopped re-advertising.
   *
   * Bounds registry growth across long uptimes with worker churn.
   */
  public prune(): void {
    const cutoff = Date.now() - this.staleAfterMs;
    for (const [pid, offer] of this.offers) {
      if (offer.lastSeen < cutoff) this.offers.delete(pid);
    }
  }
}

/**
 * Subscribes to the worker offers broadcast over the cluster channel.
 *
 * @param offers - Registry to populate.
 * @param log - Plugin logger.
 */
export function subscribeToWorkerOffers(
  offers: WorkerOfferRegistry,
  log: Logger,
): void {
  if (cluster.isWorker) return;

  try {
    cluster.on("message", (_worker, message: unknown) => {
      if (!message || typeof message !== "object") return;

      const payload = message as {
        type?: unknown;
        pid?: unknown;
        port?: unknown;
        token?: unknown;
      };
      if (payload.type !== OFFER_MESSAGE) return;

      const pid = Number(payload.pid);
      const port = Number(payload.port);
      const token = typeof payload.token === "string" ? payload.token : "";

      if (!Number.isFinite(pid) || !Number.isFinite(port)) return;
      if (port <= 0 || !token) return;

      const isNew = offers.remember({ pid, port, token, lastSeen: Date.now() });
      if (isNew) log(`Worker ${pid} offered live tap endpoint on port ${port}`);
    });
  } catch (err) {
    log(
      `Failed to listen for worker offers: ${(err as Error).message}`,
      "error",
    );
  }
}

/**
 * Asks every playback worker to re-advertise its tap endpoint.
 *
 * @param directory - Player directory of the primary.
 */
function requestWorkerAnnounce(directory: PlayerDirectory): void {
  for (const worker of directory.workers()) {
    try {
      (worker as { send?: (msg: unknown) => void })?.send?.({
        type: ANNOUNCE_MESSAGE,
      });
    } catch {
      // Worker went away between enumeration and send.
    }
  }
}

/**
 * Waits for a worker's tap endpoint to become known, re-requesting it once.
 *
 * @param directory - Player directory of the primary.
 * @param offers - Registry of advertised endpoints.
 * @param workerId - Cluster worker id.
 * @returns The advertised endpoint, or `null` on timeout.
 */
export async function waitForOffer(
  directory: PlayerDirectory,
  offers: WorkerOfferRegistry,
  workerId: number,
): Promise<WorkerOffer | null> {
  const pid = directory.workerPid(workerId);
  if (pid === null) return null;

  const known = offers.get(pid);
  if (known) return known;

  requestWorkerAnnounce(directory);

  const deadline = Date.now() + WORKER_OFFER_WAIT_MS;
  while (Date.now() < deadline) {
    await delay(WORKER_OFFER_POLL_MS);
    const offer = offers.get(pid);
    if (offer) return offer;
  }

  return null;
}

/**
 * Streams a worker-hosted player back to the API client.
 *
 * @param offer - Worker tap endpoint.
 * @param playerId - Player to stream.
 * @param res - Client response.
 */
export function proxyToWorker(
  offer: WorkerOffer,
  playerId: string,
  res: http.ServerResponse,
): void {
  const proxyReq = http.request({
    host: "127.0.0.1",
    port: offer.port,
    method: "GET",
    path: `/stream?playerKey=${encodeURIComponent(playerId)}`,
    headers: {
      [TOKEN_HEADER]: offer.token,
      accept: "*/*",
    },
  });

  let settled = false;

  const fail = (status: number, message: string): void => {
    if (settled) return;
    settled = true;

    if (res.headersSent || res.writableEnded) {
      try {
        res.destroy();
      } catch {
        // Already gone.
      }
      return;
    }

    sendJson(res, status, { error: message });
  };

  proxyReq.on("error", (err) =>
    fail(502, `Live tap unreachable: ${err.message}`),
  );

  proxyReq.on("response", (proxyRes) => {
    settled = true;

    const headers: Record<string, string> = {
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    };

    const contentType = proxyRes.headers["content-type"];
    headers["content-type"] =
      typeof contentType === "string" ? contentType : "audio/ogg";

    res.writeHead(proxyRes.statusCode ?? 200, headers);
    flushHeaders(res);
    proxyRes.pipe(res);

    proxyRes.on("error", () => {
      try {
        res.destroy();
      } catch {
        // Already gone.
      }
    });
  });

  res.on("close", () => {
    if (res.writableEnded) return;
    try {
      proxyReq.destroy();
    } catch {
      // Already gone.
    }
  });

  proxyReq.end();
}

/** Collaborators required by {@link WorkerRelayServer}. */
interface WorkerRelayServerDeps {
  settings: PluginSettings;
  log: Logger;
  registry: BroadcastRegistry;
  /** Reports whether Opus encoding is available in this process. */
  canEncode: () => boolean;
}

/**
 * Loopback-only tap endpoint hosted by every playback worker.
 *
 * Only the primary can reach it: it binds to `bindHost` (loopback by default)
 * and requires the per-process token exchanged over IPC.
 */
export class WorkerRelayServer {
  private readonly deps: WorkerRelayServerDeps;
  private server: http.Server | null = null;
  private offer: WorkerOffer | null = null;
  private announceTimer: NodeJS.Timeout | null = null;

  /**
   * Creates a relay server.
   *
   * @param deps - NodeLink settings, logger and the process' broadcasts.
   */
  constructor(deps: WorkerRelayServerDeps) {
    this.deps = deps;
  }

  /** Reports whether the relay is accepting connections. */
  public get isListening(): boolean {
    return this.server !== null;
  }

  /**
   * Binds the endpoint and starts advertising it to the primary.
   */
  public async start(): Promise<void> {
    if (this.server) return;

    const { settings, log } = this.deps;
    const token = randomBytes(24).toString("hex");

    const server = http.createServer((req, res) =>
      this.handleRequest(req, res, token),
    );

    server.on("clientError", (_err, socket) => {
      try {
        socket.destroy();
      } catch {
        // Socket already closed.
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, settings.bindHost);
    });

    const address = server.address() as AddressInfo | null;
    this.server = server;
    this.offer = {
      pid: process.pid,
      port: address?.port ?? 0,
      token,
      lastSeen: Date.now(),
    };

    log(
      `Internal tap endpoint listening on ${settings.bindHost}:${this.offer.port}`,
    );

    this.startAnnouncing();
  }

  /**
   * Advertises this process' tap endpoint to the primary.
   */
  public announce(): void {
    const offer = this.offer;
    if (!offer || typeof process.send !== "function") return;

    try {
      process.send({
        type: OFFER_MESSAGE,
        pid: offer.pid,
        port: offer.port,
        token: offer.token,
      });
    } catch (err) {
      this.deps.log(
        `Failed to announce tap endpoint: ${(err as Error).message}`,
        "warn",
      );
    }
  }

  /** Releases the endpoint and stops advertising. */
  public stop(): void {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }

    if (this.server) {
      try {
        this.server.close();
      } catch {
        // Already closed.
      }
      this.server = null;
    }

    this.offer = null;
  }

  /**
   * Announces immediately and then on every interval.
   *
   * The periodic re-announcement is a cheap safety net for a primary that
   * started listening after this worker booted.
   */
  private startAnnouncing(): void {
    this.announce();
    if (this.announceTimer) return;

    this.announceTimer = setInterval(
      () => this.announce(),
      this.deps.settings.announceIntervalMs,
    );
    this.announceTimer.unref?.();
  }

  /**
   * Handles requests arriving on the internal tap endpoint.
   *
   * @param req - Request from the primary process.
   * @param res - Response streamed back to the primary.
   * @param token - Per-process shared secret.
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    token: string,
  ): void {
    const rawToken = req.headers[TOKEN_HEADER];
    const provided = Array.isArray(rawToken) ? rawToken[0] : rawToken;

    if (provided !== token) {
      sendText(res, 403, "Forbidden");
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        players: this.deps.registry.keys(),
      });
      return;
    }

    if (url.pathname !== "/stream") {
      sendText(res, 404, "Not Found");
      return;
    }

    const playerKey = (
      url.searchParams.get("playerKey") ??
      url.searchParams.get("guildId") ??
      ""
    ).trim();

    if (!playerKey) {
      sendJson(res, 400, { error: "playerKey query parameter is required" });
      return;
    }

    // The primary always proxies a fully qualified key, so a bare guild id here
    // means the caller built the request by hand - which would be ambiguous.
    if (!isPlayerKey(playerKey)) {
      sendJson(res, 400, {
        error: "A fully qualified playerKey is required (sessionId:guildId)",
        playerKey,
      });
      return;
    }

    if (!this.deps.canEncode()) {
      sendJson(res, 503, {
        error: "Opus encoding is unavailable in this worker",
        hint: "Check the plugin logs; a compatible Opus library may be missing",
      });
      return;
    }

    this.deps.registry.attach(playerKey, res);
  }
}
