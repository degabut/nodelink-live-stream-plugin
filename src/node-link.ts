/**
 * Read-only accessors for NodeLink internals.
 *
 * Every reach into `src/` is defensive: internal shapes differ between cluster
 * and single-process modes and across NodeLink versions, and the plugin must
 * degrade gracefully rather than throw. Centralizing the probing here keeps the
 * rest of the plugin free of structural casts.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { NodelinkLike } from "./types.ts";

/** A resolved NodeLink module plus the files it could have been loaded from. */
interface LoadedModule {
  module: Record<string, unknown>;
  /** Absolute path of the file that produced the module. */
  resolvedPath: string;
  /**
   * Path relative to the process working directory, for log messages.
   *
   * Falls back to the absolute path when the module lives outside the working
   * directory, where a relative path would be a long `../..` chain.
   */
  displayPath: string;
}

/**
 * Imports a NodeLink module from either the TypeScript sources or a build
 * output.
 *
 * The plugin runs both from `src/` (Node's type stripping) and from `dist/`, so
 * every import has to try both layouts. Failure is reported by returning `null`
 * rather than throwing; callers decide whether a missing module is fatal.
 *
 * @param relativePath - Module path below `src/`, without extension, e.g.
 *   `"playback/player"`.
 * @returns The loaded module, or `null` when neither candidate exists.
 */
export async function importNodeLinkModule(
  relativePath: string,
): Promise<LoadedModule | null> {
  const root = process.cwd();
  const candidates = [
    path.join(root, "src", `${relativePath}.ts`),
    path.join(root, "dist", "src", `${relativePath}.js`),
  ];

  for (const candidate of candidates) {
    try {
      const module = (await import(pathToFileURL(candidate).href)) as Record<
        string,
        unknown
      >;

      const displayPath = path.relative(root, candidate);
      return {
        module,
        resolvedPath: candidate,
        displayPath: displayPath.startsWith("..") ? candidate : displayPath,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Extracts the guild id from a NodeLink player key (`sessionId:guildId`).
 *
 * @param playerKey - Raw player key (or a bare guild id).
 * @returns The guild id portion.
 */
export function guildFromKey(playerKey: string): string {
  return playerKey.slice(playerKey.lastIndexOf(":") + 1);
}

/**
 * Builds a NodeLink player key.
 *
 * @param sessionId - Session id, when known.
 * @param guildId - Guild id.
 * @returns `sessionId:guildId`, or a bare guild id without a session.
 */
export function playerKeyOf(sessionId: string, guildId: string): string {
  return sessionId ? `${sessionId}:${guildId}` : guildId;
}

/**
 * Promise-based delay.
 *
 * @param ms - Milliseconds to wait.
 * @returns A promise resolving after the given delay.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the cluster guild -> worker routing table.
 *
 * @param nodelink - NodeLink instance.
 * @returns The map, or `null` when clustering is off or unavailable.
 */
export function readGuildToWorker(
  nodelink: NodelinkLike,
): Map<string, number> | null {
  const manager = nodelink.workerManager as
    | { guildToWorker?: unknown }
    | null
    | undefined;
  const table = manager?.guildToWorker;
  return table instanceof Map && table.size > 0
    ? (table as Map<string, number>)
    : null;
}

/**
 * Reads the registered playback workers.
 *
 * @param nodelink - NodeLink instance.
 * @returns The worker list, or an empty array when unavailable.
 */
export function readWorkers(nodelink: NodelinkLike): unknown[] {
  const manager = nodelink.workerManager as
    | { workers?: unknown }
    | null
    | undefined;
  return Array.isArray(manager?.workers) ? manager.workers : [];
}

/**
 * Resolves the process id of a playback worker.
 *
 * @param nodelink - NodeLink instance.
 * @param workerId - Cluster worker id.
 * @returns The worker pid, or `null` when the worker is unknown.
 */
export function readWorkerPid(
  nodelink: NodelinkLike,
  workerId: number,
): number | null {
  for (const worker of readWorkers(nodelink)) {
    const entry = worker as
      | { id?: unknown; process?: { pid?: unknown } }
      | null
      | undefined;
    if (entry?.id !== workerId) continue;

    const pid = Number(entry.process?.pid);
    return Number.isFinite(pid) ? pid : null;
  }

  return null;
}

/**
 * Reads the configured server password.
 *
 * @param nodelink - NodeLink instance.
 * @returns The password, or `null` when authentication is disabled.
 */
export function readServerPassword(nodelink: NodelinkLike): string | null {
  const options = nodelink.options as
    | { server?: { password?: unknown } }
    | null
    | undefined;
  const password = options?.server?.password;
  return typeof password === "string" && password.length > 0 ? password : null;
}

/**
 * Iterates the players registered in this process.
 *
 * NodeLink's `SessionManager` exposes `values()` yielding sessions, each with a
 * `players` manager whose `players` map is keyed by `sessionId:guildId`.
 *
 * @param nodelink - NodeLink instance.
 * @returns Player keys paired with their managed player entry.
 */
export function iterateLocalPlayers(
  nodelink: NodelinkLike,
): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];

  const sessions = nodelink.sessions as
    | { values?: () => IterableIterator<Record<string, unknown>> }
    | null
    | undefined;
  if (!sessions || typeof sessions.values !== "function") return out;

  try {
    for (const session of sessions.values()) {
      const manager = session?.players as
        | { players?: unknown }
        | null
        | undefined;
      const map = manager?.players;
      if (!(map instanceof Map)) continue;

      for (const [key, player] of map as Map<string, unknown>) {
        if (typeof key === "string" && player && typeof player === "object") {
          out.push([key, player as Record<string, unknown>]);
        }
      }
    }
  } catch {
    // Registry shape changed; treat as "unknown" and let callers fail open.
  }

  return out;
}

/**
 * Reports whether the local session registry can be inspected at all.
 *
 * @param nodelink - NodeLink instance.
 * @returns `true` when `sessions.values` is callable.
 */
export function canReadSessions(nodelink: NodelinkLike): boolean {
  const sessions = nodelink.sessions as { values?: unknown } | null | undefined;
  return Boolean(sessions && typeof sessions.values === "function");
}
