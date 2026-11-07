import type { Run } from "@repo/platform-protocol";
import type { RuntimeKernelDependencies } from "./RuntimeKernel.js";
import type { StartTurnInput } from "./types.js";
import { RuntimeKernelError } from "./errors.js";

/** Capture may be omitted only when execution cannot mutate workspace contents. */
export function omitsReadOnlyArtifacts(
  dependencies: RuntimeKernelDependencies,
  run: Run,
  execution?: StartTurnInput["execution"],
): boolean {
  if (dependencies.artifactCapture !== "omitted_read_only") return false;
  if (
    execution?.kind === "delegated" ||
    run.harnessSelection?.selection != null ||
    !["ask", "review", "plan"].includes(run.mode) ||
    dependencies.worker?.executionCapability !== "read_only" ||
    dependencies.hooks !== undefined
  ) {
    throw new RuntimeKernelError(
      "tool_policy_denied",
      "Omitting artifacts requires a read-only run, a restricted read-only worker, and no executable hooks.",
    );
  }
  return true;
}
