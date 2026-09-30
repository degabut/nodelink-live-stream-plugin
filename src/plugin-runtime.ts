/**
 * Per-process orchestration.
 *
 * Composes every collaborator, dispatches on the NodeLink execution context and
 * owns the shutdown path. All business logic lives in the collaborators; this
 * class only wires them together.
 */

import { ANNOUNCE_MESSAGE, OFFER_STALE_MULTIPLIER } from "./constants.ts";
import { normalizeSettings } from "./config.ts";
import { createLogger } from "./logger.ts";
import { ApiHandler } from "./api-handler.ts";
import { BroadcastRegistry } from "./broadcast-registry.ts";
import { PlayerDirectory } from "./player-directory.ts";
import { TapInstaller } from "./audio-tap.ts";
import {
  WorkerOfferRegistry,
  WorkerRelayServer,
  subscribeToWorkerOffers,
} from "./cluster-relay.ts";
import type {
  LiveStreamConfig,
  Logger,
  MiddlewareHandler,
  NodelinkLike,
  PluginContext,
  PluginSettings,
} from "./types.ts";

/**
 * Boots the plugin for one process.
 */
export class PluginRuntime {
  private readonly nodelink: NodelinkLike;
  private readonly context: PluginContext;
  private readonly settings: PluginSettings;
  private readonly log: Logger;

  private readonly installer: TapInstaller;
  private readonly registry: BroadcastRegistry;
  private readonly offers: WorkerOfferRegistry;
  private readonly directory: PlayerDirectory;
  private readonly api: ApiHandler;
  private readonly relay: WorkerRelayServer;

  private apiInstalled = false;

  /**
   * Creates a runtime.
   *
   * @param nodelink - NodeLink instance for the current process.
   * @param config - `pluginConfig["live-stream"]` block.
   * @param context - Execution context (`master`, `worker`, ...).
   */
  constructor(
    nodelink: NodelinkLike,
    config: LiveStreamConfig | undefined,
    context: PluginContext | undefined,
  ) {
    this.nodelink = nodelink;
    this.context = context ?? {};
    this.settings = normalizeSettings(config);
    this.log = createLogger(nodelink);

    this.installer = new TapInstaller({
      nodelink,
      log: this.log,
      settings: this.settings,
    });

    this.offers = new WorkerOfferRegistry(
      this.settings.announceIntervalMs * OFFER_STALE_MULTIPLIER,
    );

    const canEncode = (): boolean => this.installer.hasEncoder;

    // The registry and the directory need each other: broadcasts ask the
    // directory whether a player is alive, and the directory asks the registry
    // for an existing broadcast key. Both references are resolved lazily, so
    // constructing them in either order is safe.
    this.registry = new BroadcastRegistry({
      settings: this.settings,
      log: this.log,
      resolveEncoderClass: this.installer.resolveEncoderClass,
      isPlayerAlive: (playerKey) => this.directory.isKnown(playerKey),
    });

    this.directory = new PlayerDirectory(nodelink, {
      hasBroadcast: (playerKey) => this.registry.has(playerKey),
    });

    this.api = new ApiHandler({
      settings: this.settings,
      log: this.log,
      registry: this.registry,
      directory: this.directory,
      offers: this.offers,
      canEncode,
    });

    this.relay = new WorkerRelayServer({
      settings: this.settings,
      log: this.log,
      registry: this.registry,
      canEncode,
    });
  }

  /**
   * Starts the plugin for the current execution context.
   *
   * The primary hosts the public API; playback workers host the audio tap and
   * the internal relay endpoint. When clustering is disabled the primary is also
   * the playback host, so it installs the tap as well.
   */
  public async start(): Promise<void> {
    const contextType = String(this.context.type ?? "unknown");
    const isPrimary = contextType === "master";
    const isPlaybackWorker =
      contextType === "worker" || contextType === "voice-worker";

    if (!isPrimary && !isPlaybackWorker) {
      this.log(`Skipping context '${contextType}'.`, "debug");
      return;
    }

    if (isPrimary) {
      this.registerApi();

      if (!this.nodelink.workerManager) await this.installTap();
    }

    if (isPlaybackWorker) {
      await this.installTap();
      await this.startRelay();
    }

    // `once` is an EventEmitter method, so it must also be called on the
    // instance to keep `this` bound.
    const once = this.nodelink.once;
    if (typeof once === "function") {
      (once as (event: string, listener: () => void) => void).call(
        this.nodelink,
        "shutdown",
        () => this.shutdown(),
      );
    }
  }

  /**
   * Registers the public API middleware on the primary process.
   */
  private registerApi(): void {
    if (this.apiInstalled) return;
    this.apiInstalled = true;

    subscribeToWorkerOffers(this.offers, this.log);

    if (typeof this.nodelink.registerMiddleware !== "function") {
      this.log(
        "registerMiddleware is unavailable; HTTP endpoint disabled.",
        "error",
      );
      return;
    }

    // Invoke as a METHOD on `nodelink`: `registerMiddleware` reads
    // `this.extensions`, so calling it unbound throws
    // "Cannot read properties of undefined (reading 'extensions')".
    const registerMiddleware = this.nodelink.registerMiddleware as (
      fn: MiddlewareHandler,
    ) => void;
    registerMiddleware.call(this.nodelink, this.api.middleware());

    this.log(
      "Registered live stream endpoints: " +
        "GET /{sessionId}:{guildId}/stream, GET /live",
    );
  }

  /**
   * Installs the audio interceptor in a process that owns players.
   *
   * Failure is logged rather than thrown: the plugin still exposes `/live`, and
   * a clustered primary can still relay from its workers.
   */
  private async installTap(): Promise<void> {
    try {
      await this.installer.install(this.registry);
    } catch (err) {
      this.log(
        `Failed to install the audio tap: ${(err as Error).message}`,
        "error",
      );
    }
  }

  /**
   * Starts the internal relay endpoint and the worker-side hooks.
   */
  private async startRelay(): Promise<void> {
    try {
      await this.relay.start();
      this.registerWorkerHooks();
    } catch (err) {
      this.log(
        `Failed to start the internal tap endpoint: ${(err as Error).message}`,
        "error",
      );
    }
  }

  /**
   * Registers the IPC hook and the destroy-player interceptor in a worker.
   */
  private registerWorkerHooks(): void {
    const pluginManager = this.nodelink.pluginManager as
      | { registerHook?: (name: string, cb: (msg: unknown) => void) => void }
      | undefined;

    pluginManager?.registerHook?.("onIPCMessage", (message: unknown) => {
      const type = (message as { type?: unknown } | null)?.type;
      if (type === ANNOUNCE_MESSAGE) this.relay.announce();
    });

    // In a worker the session registry is not reachable, so the watchdog cannot
    // detect a destroyed player. NodeLink's destroyPlayer command is the
    // authoritative signal instead: close the stream as the player goes.
    //
    // The worker exposes this as an arrow property today, but the primary's
    // `register*` methods are prototype methods, so bind `this` defensively.
    const registerWorkerInterceptor = this.nodelink
      .registerWorkerInterceptor as
      | ((fn: (type: string, payload: unknown) => boolean) => void)
      | undefined;

    registerWorkerInterceptor?.call(this.nodelink, (type, payload) => {
      if (type !== "destroyPlayer") return false;

      const { sessionId, guildId } = (payload ?? {}) as {
        sessionId?: unknown;
        guildId?: unknown;
      };
      const guild = typeof guildId === "string" ? guildId : "";
      const session = typeof sessionId === "string" ? sessionId : "";

      // Players are always addressed by the full `sessionId:guildId` key, so
      // only close when both halves are present. Closing by bare guild would
      // tear down every session playing in that guild.
      if (session && guild) this.registry.close(`${session}:${guild}`);
      // Never block the command itself.
      return false;
    });
  }

  /** Releases every resource owned by the plugin. */
  private shutdown(): void {
    this.relay.stop();
    this.registry.shutdown();
  }
}
