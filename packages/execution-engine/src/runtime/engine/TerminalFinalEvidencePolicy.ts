import type { TranscriptPart } from "@repo/platform-protocol";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import { projectExplicitFinalText } from "./FinalPartValidator.js";
import type { TerminalSettlement } from "./TerminalSettlementProjector.js";

/**
 * Prevents legacy callers from persisting a successful terminal run without a
 * model-authored typed final. The native kernel rejects this earlier; this is
 * the final shared settlement invariant.
 */
export function enforceTerminalFinalEvidence(input: {
  settlement: TerminalSettlement;
  modelParts?: readonly TranscriptPart[];
}): TerminalSettlement {
  if (
    input.settlement.terminalStatus !== "COMPLETED" ||
    projectExplicitFinalText(input.modelParts ?? [])
  ) {
    return input.settlement;
  }

  return {
    terminalState: RUN_TERMINAL_STATES.FAILED_VALIDATION,
    outcomeCode: "MODEL_FINAL_MISSING",
    terminalStatus: "FAILED",
  };
}
