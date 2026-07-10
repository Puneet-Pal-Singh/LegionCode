import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import type { RunTerminalState } from "@repo/shared-types";
import type { Run } from "../run/index.js";
import type { AgenticLoopToolLifecycleEvent } from "../types.js";
import { FinalAssistantMessageService } from "./FinalAssistantMessageService.js";

export function buildFinalAssistantMessage(input: {
  run: Run;
  text: string;
  metadata?: Record<string, unknown>;
  terminalState: RunTerminalState;
}) {
  return new FinalAssistantMessageService().build({
    runId: input.run.id,
    sessionId: input.run.sessionId,
    terminalState: input.terminalState,
    modelText: input.text,
    metadata: input.metadata,
  });
}

export function buildTerminalFinalMetadata(input: {
  run: Run;
  metadata?: Record<string, unknown>;
  terminalState: RunTerminalState;
}): Record<string, unknown> {
  const lifecycle = input.run.metadata.agenticLoop?.toolLifecycle ?? [];
  const changedFileCount =
    readNonNegativeInteger(input.metadata?.changedFileCount) ??
    countChangedFiles(lifecycle);
  const lastSuccessfulStep =
    readNonEmptyString(input.metadata?.lastSuccessfulStep) ??
    getLatestToolName(lifecycle, "completed");
  const failedStep =
    readNonEmptyString(input.metadata?.failedStep) ??
    getLatestToolName(lifecycle, "failed");
  const nextAction =
    readNonEmptyString(input.metadata?.nextAction) ??
    readNonEmptyString(input.metadata?.resumeHint) ??
    resolveDefaultTerminalNextAction(input.terminalState);

  return {
    ...(input.metadata ?? {}),
    terminalState: input.terminalState,
    changedFileCount,
    artifactId: input.metadata?.artifactId ?? null,
    lastSuccessfulStep,
    failedStep,
    nextAction,
  };
}

function countChangedFiles(lifecycle: AgenticLoopToolLifecycleEvent[]): number {
  const filePaths = new Set<string>();
  for (const event of lifecycle) {
    if (
      event.status === "completed" &&
      event.metadata?.family === "edit" &&
      event.metadata.filePath
    ) {
      filePaths.add(event.metadata.filePath);
    }
  }
  return filePaths.size;
}

function getLatestToolName(
  lifecycle: AgenticLoopToolLifecycleEvent[],
  status: AgenticLoopToolLifecycleEvent["status"],
): string | null {
  for (let index = lifecycle.length - 1; index >= 0; index -= 1) {
    const event = lifecycle[index];
    if (event?.status === status) {
      return event.toolName;
    }
  }
  return null;
}

function resolveDefaultTerminalNextAction(
  terminalState: RunTerminalState,
): string {
  switch (terminalState) {
    case RUN_TERMINAL_STATES.COMPLETED:
      return "Send the next task when you want me to continue.";
    case RUN_TERMINAL_STATES.APPROVAL_REQUIRED:
      return "Choose an approval action to continue, or deny to stop this path.";
    case RUN_TERMINAL_STATES.APPROVAL_DENIED:
      return "Send a revised instruction or approve a safer action to continue.";
    case RUN_TERMINAL_STATES.INTERRUPTED:
      return "Resubmit the request when you want me to continue.";
    default:
      return "Review the completed work and retry the failed step.";
  }
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
