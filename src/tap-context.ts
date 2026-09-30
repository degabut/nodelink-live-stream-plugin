/**
 * Async context used to attribute audio resources to a player.
 *
 * One module-level storage instance is shared by the player patcher (writer) and
 * the tap stream (reader).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TapContext } from "./types.ts";

/** Guild attribution propagated through a player's asynchronous execution. */
export const tapContext = new AsyncLocalStorage<TapContext>();
