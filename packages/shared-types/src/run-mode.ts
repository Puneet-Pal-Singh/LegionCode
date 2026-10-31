export {
  ChatRunModeSchema as RunModeSchema,
  type ChatRunMode as RunMode,
} from "@repo/platform-protocol";
import type { ChatRunMode } from "@repo/platform-protocol";

export const DEFAULT_RUN_MODE: ChatRunMode = "build";
