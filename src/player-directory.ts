/**
 * Player discovery and hosting lookup.
 *
 * Encapsulates every query the plugin makes about the players of a process and
 * about the cluster's guild -> worker routing table. Probing is centralized in
 * `node-link.ts`; this module adds the plugin's own resolution policy.
 */

import {
  canReadSessions,
  guildFromKey,
  iterateLocalPlayers,
  readGuildToWorker,
  readWorkerPid,
  readWorkers,
} from "./node-link.ts";
import type { NodelinkLike, StreamTarget } from "./types.ts";

/** Collaborators required by {@link PlayerDirectory}. */
interface PlayerDirectoryDeps {
  /** Reports whether a broadcast exists for an exact player key. */
  hasBroadcast: (playerKey: string) => boolean;
}

/**
 * Answers "where does this player live?" questions.
 */
export class PlayerDirectory {
  private readonly nodelink: NodelinkLike;
  private readonly deps: PlayerDirectoryDeps;

  /**
   * Creates a directory.
   *
   * @param nodelink - NodeLink instance of the current process.
   * @param deps - Collaborators.
   */
  constructor(nodelink: NodelinkLike, deps: PlayerDirectoryDeps) {
    this.nodelink = nodelink;
    this.deps = deps;
  }

  /**
   * Reads the guild -> worker routing table.
   *
   * @returns The table, or `null` when clustering is off.
   */
  public guildToWorker(): Map<string, number> | null {
    return readGuildToWorker(this.nodelink);
  }

  /**
   * Lists the players registered in this process.
   *
   * @returns Player keys paired with their managed player entry.
   */
  public listLocal(): Array<[string, Record<string, unknown>]> {
    return iterateLocalPlayers(this.nodelink);
  }

  /**
   * Finds the player key for an id among the players of this process.
   *
   * Only an exact key matches. A bare guild id would be ambiguous whenever two
   * sessions play in the same guild, so it never resolves.
   *
   * @param playerKey - Fully qualified player key (`sessionId:guildId`).
   * @returns The matching player key, or `null`.
   */
  public findKey(playerKey: string): string | null {
    const players = this.listLocal();

    const exact = players.find(([key]) => key === playerKey);
    return exact ? exact[0] : null;
  }

  /**
   * Reports whether a player still exists.
   *
   * This is what decides how long a keep-alive stream lives. It **fails open**:
   * if the player registry cannot be inspected, the player is assumed to be
   * alive so an unexpected internal shape can never terminate live streams.
   *
   * @param playerKey - Fully qualified player key (`sessionId:guildId`).
   * @returns `true` when the player should be considered alive.
   */
  public isKnown(playerKey: string): boolean {
    const table = this.guildToWorker();

    if (table) return table.has(playerKey);

    // Non-cluster: the session registry is authoritative. If it cannot be read,
    // fail open rather than tearing down streams on a wrong assumption.
    if (!canReadSessions(this.nodelink)) return true;

    return this.findKey(playerKey) !== null;
  }

  /**
   * Resolves the process id of a playback worker.
   *
   * @param workerId - Cluster worker id.
   * @returns The worker pid, or `null` when unknown.
   */
  public workerPid(workerId: number): number | null {
    return readWorkerPid(this.nodelink, workerId);
  }

  /**
   * Lists the cluster workers so they can be asked to re-advertise.
   *
   * @returns The raw worker entries.
   */
  public workers(): unknown[] {
    return readWorkers(this.nodelink);
  }

  /**
   * Finds where a player is hosted.
   *
   * @param playerKey - Fully qualified player key (`sessionId:guildId`).
   * @returns Target descriptor, or `null` when the player is not registered.
   */
  public resolveTarget(playerKey: string): StreamTarget | null {
    const table = this.guildToWorker();

    if (table) {
      const workerId = table.get(playerKey);
      return typeof workerId === "number" ? { playerKey, workerId } : null;
    }

    // Cluster disabled: players live in this very process. Accept an existing
    // broadcast, or a player known to the session registry that has not played
    // anything yet (and therefore has no broadcast).
    const local = this.deps.hasBroadcast(playerKey) || this.findKey(playerKey);
    return local ? { playerKey, workerId: null } : null;
  }

  /**
   * Extracts the guild id from a player key.
   *
   * @param playerKey - Fully qualified player key (`sessionId:guildId`).
   * @returns The guild id portion.
   */
  public guildOf(playerKey: string): string {
    return guildFromKey(playerKey);
  }
}
