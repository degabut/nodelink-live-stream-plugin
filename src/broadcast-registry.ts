/**
 * Registry of active per-player broadcasts.
 *
 * Owns the lifetime of every {@link LiveBroadcast}: creation, key resolution
 * (bare guild id vs. `sessionId:guildId`) and removal once a broadcast becomes
 * unused.
 */

import type { ServerResponse } from "node:http";
import { guildFromKey } from "./node-link.ts";
import { LiveBroadcast } from "./live-broadcast.ts";
import { StreamClient } from "./stream-client.ts";
import type {
  Logger,
  OpusEncoderConstructor,
  PluginSettings,
} from "./types.ts";

/** Collaborators required by {@link BroadcastRegistry}. */
interface BroadcastRegistryDeps {
  settings: PluginSettings;
  log: Logger;
  /** Resolves the NodeLink Opus `Encoder` class, or `null` when unavailable. */
  resolveEncoderClass: () => OpusEncoderConstructor | null;
  /** Reports whether a player still exists. */
  isPlayerAlive: (playerKey: string) => boolean;
}

/**
 * Tracks the live broadcasts of this process.
 */
export class BroadcastRegistry {
  private readonly deps: BroadcastRegistryDeps;
  private readonly broadcasts = new Map<string, LiveBroadcast>();

  /**
   * Creates a registry.
   *
   * @param deps - Collaborators forwarded to each broadcast.
   */
  constructor(deps: BroadcastRegistryDeps) {
    this.deps = deps;
  }

  /** Player keys of the active broadcasts. */
  public keys(): string[] {
    return Array.from(this.broadcasts.keys());
  }

  /** Active broadcasts. */
  public values(): LiveBroadcast[] {
    return Array.from(this.broadcasts.values());
  }

  /**
   * Returns the broadcast for a player, creating it when needed.
   *
   * @param playerKey - NodeLink player key (`sessionId:guildId`).
   * @param guildId - Guild id owning the audio.
   * @returns The broadcast hub.
   */
  public getOrCreate(playerKey: string, guildId: string): LiveBroadcast {
    const existing = this.broadcasts.get(playerKey);
    if (existing) return existing;

    const created = new LiveBroadcast(playerKey, guildId, {
      settings: this.deps.settings,
      log: this.deps.log,
      resolveEncoderClass: this.deps.resolveEncoderClass,
      isPlayerAlive: () => this.deps.isPlayerAlive(playerKey),
      onDisposed: (broadcast) => {
        if (this.broadcasts.get(broadcast.playerKey) === broadcast) {
          this.broadcasts.delete(broadcast.playerKey);
        }
      },
    });

    this.broadcasts.set(playerKey, created);
    return created;
  }

  /**
   * Reports whether a broadcast is registered for a player key.
   *
   * Keys are always matched verbatim. A bare guild id is never resolved to a
   * broadcast, because two sessions playing in the same guild would make that
   * result arbitrary - a caller could be handed another bot's audio.
   *
   * @param playerKey - Fully qualified player key (`sessionId:guildId`).
   * @returns `true` when a broadcast exists for the key.
   */
  public has(playerKey: string): boolean {
    return this.broadcasts.has(playerKey);
  }

  /**
   * Subscribes an HTTP response to a player's live broadcast.
   *
   * @param playerKey - Fully qualified player key (`sessionId:guildId`).
   * @param res - HTTP response to stream into.
   */
  public attach(playerKey: string, res: ServerResponse): void {
    const broadcast = this.getOrCreate(playerKey, guildFromKey(playerKey));

    const client = new StreamClient(res, {
      pagePackets: this.deps.settings.opusPagePackets,
      maxBufferBytes: this.deps.settings.maxClientBufferBytes,
    });

    client.open();
    broadcast.subscribe(client);

    client.onDisconnect(() => {
      // A listener that already failed is dropped by the broadcast itself;
      // detaching twice would double-count the teardown.
      if (client.isClosed) return;
      client.markDetached();
      broadcast.unsubscribe(client);
    });
  }

  /**
   * Closes the broadcast for a player, if one exists.
   *
   * The key is matched verbatim: closing every broadcast that happens to share
   * a guild would tear down unrelated sessions (for example a second bot
   * instance playing in the same guild).
   *
   * @param playerKey - Fully qualified player key (`sessionId:guildId`).
   */
  public close(playerKey: string): void {
    this.broadcasts.get(playerKey)?.close();
  }

  /** Releases every broadcast owned by the registry. */
  public shutdown(): void {
    for (const broadcast of this.values()) broadcast.close();
    this.broadcasts.clear();
  }
}
