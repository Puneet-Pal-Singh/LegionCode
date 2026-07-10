import type { RunTerminalState } from "@repo/shared-types";
import type { Run } from "../run/index.js";
import { FinalAssistantMessageService, type FinalVisiblePart } from "./FinalAssistantMessageService.js";
import type { TerminalSettlement } from "./TerminalSettlementProjector.js";

export function buildFinalAssistantMessage(input: {
  run: Run;
  text?: string;
  finalParts?: readonly FinalVisiblePart[];
  metadata?: Record<string, unknown>;
  settlement: TerminalSettlement;
}) {
  const finalParts = input.settlement.outcomeCode === "FINALIZATION_MISSING_EVIDENCE"
    ? undefined
    : input.finalParts ??
      (input.text?.trim()
        ? ([{ type: "final", text: input.text }] as const)
        : undefined);
  return new FinalAssistantMessageService().build({
    terminalState: input.settlement.terminalState,
    outcomeCode: input.settlement.outcomeCode,
    finalParts,
    metadata: input.metadata,
  });
}

export function buildTerminalFinalMetadata(input: {
  metadata?: Record<string, unknown>;
  terminalState: RunTerminalState;
  outcomeCode: TerminalSettlement["outcomeCode"];
}): Record<string, unknown> {
  return {
    ...(input.metadata ?? {}),
    terminalState: input.terminalState,
    outcomeCode: input.outcomeCode,
  };
}
