/**
 * Logger construction for the Live Stream plugin.
 */

import { PLUGIN_NAME } from "./constants.ts";
import type { Logger, NodelinkLike, ServerLogger } from "./types.ts";

/**
 * Builds the plugin logger from `nodelink.logger`.
 *
 * `nodelink.logger` is a plain function stored as a property rather than a
 * prototype method, so it is safe to detach. When it is missing the returned
 * logger is a no-op.
 *
 * @param nodelink - NodeLink instance.
 * @returns A logger prefixing every message with the plugin name.
 */
export function createLogger(nodelink: NodelinkLike): Logger {
  const serverLogger = nodelink.logger as ServerLogger | undefined;
  if (typeof serverLogger !== "function") return () => {};

  return (message: string, level = "info") =>
    serverLogger(level, `Plugin:${PLUGIN_NAME}`, message);
}
