import { PluginRuntime } from "./src/plugin-runtime.ts";
import type {
  LiveStreamConfig,
  NodelinkLike,
  PluginContext,
} from "./src/types.ts";

export default async function liveStreamPlugin(
  nodelink: NodelinkLike,
  config: LiveStreamConfig | undefined,
  context: PluginContext | undefined,
): Promise<void> {
  await new PluginRuntime(nodelink, config, context).start();
}

export {
  PLUGIN_NAME,
  OFFER_MESSAGE,
  ANNOUNCE_MESSAGE,
} from "./src/constants.ts";
