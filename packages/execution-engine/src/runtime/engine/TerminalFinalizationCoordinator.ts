import type { Run } from "../run/index.js";
import { recordLifecycleStep, recordOrchestrationTerminal } from "./RunMetadataPolicy.js";
import { transitionRunToCompleted, transitionRunToFailed, transitionRunToPaused } from "./RunStatusPolicy.js";
import type { FinalAssistantMessageResult } from "./FinalAssistantMessageService.js";
import type { TerminalSettlement } from "./TerminalSettlementProjector.js";

/** Owns the single in-memory terminal settlement before persistence is attempted. */
export function settleTerminalRun(input: {
  run: Run;
  settlement: TerminalSettlement;
  finalMessage: FinalAssistantMessageResult;
  redactedContent: string;
}): void {
  const { run, settlement, finalMessage, redactedContent } = input;
  recordLifecycleStep(run, "SYNTHESIS");
  if (settlement.terminalStatus === "PAUSED") {
    transitionRunToPaused(run, run.id);
  } else if (settlement.terminalStatus === "FAILED") {
    transitionRunToFailed(run, run.id);
  } else {
    transitionRunToCompleted(run, run.id);
  }
  recordLifecycleStep(run, "TERMINAL", `status=${settlement.terminalStatus}`);
  recordOrchestrationTerminal(run);
  run.output = { content: redactedContent, finalSummary: redactedContent };
  run.metadata.terminalState = settlement.terminalState;
  run.metadata.terminalMessage = finalMessage.metadata;
}
