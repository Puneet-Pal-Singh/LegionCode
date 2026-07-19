import { RUN_TERMINAL_STATES, type RunTerminalState } from "@repo/shared-types";
import type { FinalizationContract } from "./EvidenceLedger.js";

export type TerminalOutcomeCode =
  | "COMPLETED"
  | "COMPLETED_WITH_WARNINGS"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_RESOLVED"
  | "APPROVAL_DENIED"
  | "TOOL_EXECUTION_FAILED"
  | "VALIDATION_FAILED"
  | "POLICY_BLOCKED"
  | "INTERRUPTED"
  | "RUNTIME_FAILED"
  | "MODEL_FINAL_MISSING"
  | "FINALIZATION_MISSING_EVIDENCE";

export interface TerminalSettlement {
  terminalState: RunTerminalState;
  outcomeCode: TerminalOutcomeCode;
  terminalStatus: "COMPLETED" | "PAUSED" | "FAILED";
}

export function projectTerminalSettlement(input: {
  terminalState: RunTerminalState;
  contract: FinalizationContract;
  terminalStatusHint?: "PAUSED";
}): TerminalSettlement {
  if (input.terminalState === RUN_TERMINAL_STATES.APPROVAL_REQUIRED) {
    return {
      terminalState: input.terminalState,
      outcomeCode: "APPROVAL_REQUIRED",
      terminalStatus: "PAUSED",
    };
  }
  if (!input.contract.settled) {
    return {
      terminalState: RUN_TERMINAL_STATES.FAILED_VALIDATION,
      outcomeCode: "FINALIZATION_MISSING_EVIDENCE",
      terminalStatus: "FAILED",
    };
  }

  const outcomeCode = outcomeCodeForTerminalState(input.terminalState);
  if (
    input.terminalState === RUN_TERMINAL_STATES.INTERRUPTED &&
    input.terminalStatusHint === "PAUSED"
  ) {
    return {
      terminalState: input.terminalState,
      outcomeCode,
      terminalStatus: "PAUSED",
    };
  }
  return {
    terminalState: input.terminalState,
    outcomeCode,
    terminalStatus:
      input.terminalState === RUN_TERMINAL_STATES.APPROVAL_RESOLVED
        ? "COMPLETED"
        : input.terminalState === RUN_TERMINAL_STATES.COMPLETED ||
            input.terminalState === RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS
          ? "COMPLETED"
          : "FAILED",
  };
}

function outcomeCodeForTerminalState(
  terminalState: RunTerminalState,
): TerminalOutcomeCode {
  switch (terminalState) {
    case RUN_TERMINAL_STATES.COMPLETED:
      return "COMPLETED";
    case RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS:
      return "COMPLETED_WITH_WARNINGS";
    case RUN_TERMINAL_STATES.APPROVAL_REQUIRED:
      return "APPROVAL_REQUIRED";
    case RUN_TERMINAL_STATES.APPROVAL_RESOLVED:
      return "APPROVAL_RESOLVED";
    case RUN_TERMINAL_STATES.APPROVAL_DENIED:
      return "APPROVAL_DENIED";
    case RUN_TERMINAL_STATES.FAILED_TOOL:
      return "TOOL_EXECUTION_FAILED";
    case RUN_TERMINAL_STATES.FAILED_VALIDATION:
      return "VALIDATION_FAILED";
    case RUN_TERMINAL_STATES.FAILED_POLICY:
      return "POLICY_BLOCKED";
    case RUN_TERMINAL_STATES.INTERRUPTED:
      return "INTERRUPTED";
    case RUN_TERMINAL_STATES.FAILED_RUNTIME:
    default:
      return "RUNTIME_FAILED";
  }
}
