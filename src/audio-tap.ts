/**
 * Audio tap installation.
 *
 * The tap is a pure pass-through `Transform` inserted after the filters and
 * before the Opus encoder, so it mirrors exactly the signal Discord receives
 * without delaying or altering it. Nothing inside `src/` is modified: the tap
 * learns which player it belongs to by wrapping the `Player` playback entry
 * points with an AsyncLocalStorage scope.
 */

import type { Buffer } from "node:buffer";
import { Transform } from "node:stream";
import { TAP_HIGH_WATER_MARK } from "./constants.ts";
import { importNodeLinkModule, playerKeyOf } from "./node-link.ts";
import { tapContext } from "./tap-context.ts";
import type { BroadcastRegistry } from "./broadcast-registry.ts";
import type {
  Logger,
  NodelinkLike,
  OpusEncoderConstructor,
  PluginSettings,
  TapContext,
} from "./types.ts";

/**
 * Player methods wrapped so the audio tap knows which player it belongs to.
 *
 * `play`, `seek` and `preload` are the stable public entry points and cover
 * every resource-creation path, including the ones that never call
 * `_fetchResource`:
 *
 * - `play` -> `_connectAndPlayStream` (seekable resource when resuming at a position)
 * - `seek` -> `_seekeableSeek` / `_seekUsingSource` / `_legacySeek`
 * - `preload` -> `_fetchResource`
 *
 * `_fetchResource` is wrapped as well as a safety net for direct callers.
 */
const TAPPED_METHODS = ["play", "seek", "preload", "_fetchResource"] as const;

/**
 * Checks whether a tap still belongs to the resource the player is playing.
 *
 * The resource is identified through its `pipes` array, which the stream
 * processor fills with every interceptor it inserts. This works for *all*
 * resource-creation paths, including the ones that build a resource directly
 * (`createSeekeableAudioResource`) instead of going through `_fetchResource`.
 *
 * Gapless playback and crossfades briefly keep two resources alive, so without
 * this gate a listener could receive two overlapping mixes.
 *
 * @param player - Player owning the tap.
 * @param tap - Tap stream being evaluated.
 * @returns `true` when the frame should be forwarded.
 */
function isCurrentTap(
  player: Record<string, unknown> | null,
  tap: Transform,
): boolean {
  if (!player) return true;

  const current = player._currentResource as
    | { pipes?: Array<{ destroy?: () => void }> }
    | null
    | undefined;
  if (!current) return true;

  const pipes = current.pipes;
  if (!Array.isArray(pipes)) return true;

  return pipes.includes(tap);
}

/**
 * Wraps the `Player` prototype so playback entry points run inside a tap
 * context.
 */
class PlayerPatcher {
  private readonly log: Logger;

  /**
   * Creates a patcher.
   *
   * @param log - Plugin logger.
   */
  constructor(log: Logger) {
    this.log = log;
  }

  /**
   * Locates the `Player` class and wraps its playback entry points.
   *
   * @returns `true` when the patch was applied.
   */
  public async patch(): Promise<boolean> {
    const loaded = await importNodeLinkModule("playback/player");

    if (!loaded) {
      this.log("Could not locate the NodeLink Player class.", "error");
      return false;
    }

    const prototype = (
      loaded.module.Player as
        | { prototype?: Record<string, unknown> }
        | undefined
    )?.prototype;

    if (!prototype) {
      this.log(
        `Could not locate the NodeLink Player class in ${loaded.resolvedPath}.`,
        "error",
      );
      return false;
    }

    const wrapped = TAPPED_METHODS.filter((name) =>
      this.wrapMethod(prototype, name),
    );

    if (!wrapped.includes("play")) {
      this.log(
        `Player#play missing in ${loaded.resolvedPath}; live tapping disabled.`,
        "warn",
      );
      return false;
    }

    this.log(
      `Attached live audio tap to Player ` +
        `(${loaded.displayPath}) [wrapped: ${wrapped.join(", ")}]`,
    );
    return true;
  }

  /**
   * Wraps a single `Player` prototype method in the tap context scope.
   *
   * @param prototype - `Player.prototype`.
   * @param name - Method name to wrap.
   * @returns `true` when the method existed and was wrapped.
   */
  private wrapMethod(
    prototype: Record<string, unknown>,
    name: string,
  ): boolean {
    const original = prototype[name];
    if (typeof original !== "function") return false;

    const method = original as (
      this: Record<string, unknown>,
      ...args: unknown[]
    ) => unknown;

    prototype[name] = function tapScopedMethod(
      this: Record<string, unknown>,
      ...args: unknown[]
    ): unknown {
      const guildId = String(this.guildId ?? "");
      const sessionId = String(
        (this.session as { id?: unknown } | undefined)?.id ?? "",
      );

      const store: TapContext = {
        playerKey: playerKeyOf(sessionId, guildId),
        guildId,
        player: this,
      };

      return tapContext.run(store, () => method.apply(this, args));
    };

    return true;
  }
}

/** Collaborators required by {@link TapInstaller}. */
interface TapInstallerDeps {
  nodelink: NodelinkLike;
  log: Logger;
  settings: PluginSettings;
}

/**
 * Installs the audio interceptor and resolves the Opus encoder class.
 *
 * Both concerns live in the process that owns players, so they are installed
 * together.
 */
export class TapInstaller {
  private readonly deps: TapInstallerDeps;
  private encoderClass: OpusEncoderConstructor | null = null;
  private installed = false;
  private warnedUnattributed = false;

  /**
   * Creates an installer.
   *
   * @param deps - NodeLink instance and logger.
   */
  constructor(deps: TapInstallerDeps) {
    this.deps = deps;
  }

  /**
   * Reports whether Opus encoding is possible in this process.
   *
   * @returns `true` once the `Encoder` class has been resolved.
   */
  public get hasEncoder(): boolean {
    return this.encoderClass !== null;
  }

  /**
   * Resolves the Opus encoder class.
   *
   * Stable function reference, safe to hand to the broadcast registry which
   * resolves the class lazily on every first listener.
   *
   * @returns The class, or `null` when unavailable.
   */
  public readonly resolveEncoderClass = (): OpusEncoderConstructor | null =>
    this.encoderClass;

  /**
   * Wraps the player class, resolves the encoder and registers the interceptor.
   *
   * @param registry - Registry used to look up broadcasts for tapped audio.
   * @returns `true` when the interceptor was registered.
   */
  public async install(registry: BroadcastRegistry): Promise<boolean> {
    if (this.installed) return true;

    const { nodelink, log } = this.deps;

    if (typeof nodelink.registerAudioInterceptor !== "function") {
      log(
        "registerAudioInterceptor is unavailable; live tapping disabled.",
        "error",
      );
      return false;
    }

    if (!(await new PlayerPatcher(log).patch())) return false;

    // Only processes that own players can serve Opus.
    await this.loadEncoderClass();

    // Invoke as a METHOD on `nodelink`: NodeLink's register* methods are class
    // methods that read `this.extensions`, so extracting one into a local
    // variable and calling it unbound would throw.
    const register = nodelink.registerAudioInterceptor as (
      fn: () => Transform,
    ) => void;
    register.call(nodelink, () => this.createTapTransform(registry));

    this.installed = true;
    return true;
  }

  /**
   * Creates the pipeline interceptor that mirrors PCM into a broadcast.
   *
   * @param registry - Registry used to look up the broadcast for a player.
   * @returns A `Transform` inserted into the player's output pipeline.
   */
  private createTapTransform(registry: BroadcastRegistry): Transform {
    const ctx = tapContext.getStore();

    if (!ctx || !ctx.playerKey) {
      // A resource was built outside every wrapped player method. Audio from it
      // cannot be attributed to a player, so warn once instead of dropping it
      // silently - a persistent warning means a NodeLink path needs wrapping.
      if (!this.warnedUnattributed) {
        this.warnedUnattributed = true;
        this.deps.log(
          "Created an unattributed audio tap (no player context); audio from " +
            "this resource will not be streamed.",
          "warn",
        );
      }

      return new Transform({
        transform(chunk, _encoding, callback) {
          callback(null, chunk);
        },
      });
    }

    const broadcast = registry.getOrCreate(ctx.playerKey, ctx.guildId);
    broadcast.addTap();

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      broadcast.removeTap();
    };

    // `tap` is captured by the handlers below, which only run after the
    // constructor returns, so the self-reference is always initialized.
    const tap: Transform = new Transform({
      highWaterMark: TAP_HIGH_WATER_MARK,
      transform(this: Transform, chunk, _encoding, callback) {
        try {
          if (isCurrentTap(ctx.player, tap)) broadcast.push(chunk as Buffer);
        } catch {
          // Never let tap bookkeeping break playback.
        }
        callback(null, chunk);
      },
      flush(callback) {
        release();
        callback();
      },
      destroy(err, callback) {
        release();
        callback(err);
      },
    });

    return tap;
  }

  /**
   * Resolves the NodeLink Opus `Encoder` class.
   *
   * The class lives in the playback module, so it is imported the same way as
   * the `Player` class. Failure is non-fatal: only the Opus format is disabled.
   */
  private async loadEncoderClass(): Promise<void> {
    if (this.encoderClass) return;

    const loaded = await importNodeLinkModule("playback/opus/Opus");
    const Encoder = loaded?.module.Encoder;

    if (typeof Encoder === "function") {
      this.encoderClass = Encoder as OpusEncoderConstructor;
      this.deps.log(
        `Loaded the NodeLink Opus encoder from ${loaded?.displayPath} ` +
          `(${this.deps.settings.opusBitrate} bit/s target)`,
      );
      return;
    }

    this.deps.log(
      "Opus encoder unavailable; Opus requests will be rejected.",
      "warn",
    );
  }
}
