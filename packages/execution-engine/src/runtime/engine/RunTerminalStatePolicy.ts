import { RUN_TERMINAL_STATES, type RunTerminalState } from "@repo/shared-types";
import type { AgenticLoopResult } from "./AgenticLoop.js";

export function resolveLoopTerminalState(input: {
  loopResult: AgenticLoopResult;
  metadata?: Record<string, unknown>;
}): RunTerminalState {
  if (input.loopResult.stopReason === "cancelled") {
    return RUN_TERMINAL_STATES.INTERRUPTED;
  }

  const code =
    typeof input.metadata?.code === "string"
      ? input.metadata.code
      : undefined;
  if (code === "PERMISSION_DENIED") {
    return RUN_TERMINAL_STATES.FAILED_POLICY;
  }
  if (input.loopResult.stopReason === "tool_error") {
    return RUN_TERMINAL_STATES.FAILED_TOOL;
  }
  if (
    code === "TASK_MODEL_NO_ACTION" ||
    input.loopResult.stopReason === "max_steps_reached" ||
    input.loopResult.stopReason === "budget_exceeded"
  ) {
    return RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS;
  }

  if (input.loopResult.failedToolCount > 0) {
    return RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS;
  }

  return RUN_TERMINAL_STATES.COMPLETED;
}

export function shouldUseDeterministicTerminalSummary(
  terminalState: RunTerminalState,
): boolean {
  return terminalState !== RUN_TERMINAL_STATES.COMPLETED;
}
