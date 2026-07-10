import type { RunTerminalState } from "@repo/shared-types";
import type { Run } from "../run/index.js";
import { FinalAssistantMessageService, type FinalVisiblePart } from "./FinalAssistantMessageService.js";
import type { TerminalSettlement } from "./TerminalSettlementProjector.js";

export function buildFinalAssistantMessage(input: {
  run: Run;
  finalParts: readonly FinalVisiblePart[];
  metadata?: Record<string, unknown>;
  settlement: TerminalSettlement;
}) {
  return new FinalAssistantMessageService().build({
    terminalState: input.settlement.terminalState,
    outcomeCode: input.settlement.outcomeCode,
    finalParts: input.finalParts,
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
