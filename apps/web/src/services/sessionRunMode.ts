import { DEFAULT_RUN_MODE, RunModeSchema, type RunMode } from "@repo/shared-types";

export function normalizeSessionRunMode(mode: string | undefined): RunMode {
  if (mode === "auto_edit") {
    return "build";
  }
  return RunModeSchema.parse(mode ?? DEFAULT_RUN_MODE);
}
