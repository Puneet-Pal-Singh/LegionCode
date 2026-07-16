import type { RunTerminalState } from "@repo/shared-types";
import type { Run } from "../run/index.js";
import { FinalAssistantMessageService } from "./FinalAssistantMessageService.js";
import type { TerminalSettlement } from "./TerminalSettlementProjector.js";

export function buildFinalAssistantMessage(input: {
  run: Run;
  modelParts?: readonly import("@repo/platform-protocol").TranscriptPart[];
  runtimeText?: string;
  metadata?: Record<string, unknown>;
  settlement: TerminalSettlement;
}) {
  return new FinalAssistantMessageService().build({
    terminalState: input.settlement.terminalState,
    outcomeCode: input.settlement.outcomeCode,
    modelParts: input.modelParts,
    runtimeText: input.runtimeText,
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
