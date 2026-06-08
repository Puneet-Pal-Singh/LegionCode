import { RUN_EVENT_TYPES, type RunEvent } from "@repo/shared-types";
import {
  isApprovalRequiredRunStatus,
  isTerminalRunStatus,
  normalizeRunStatus,
} from "../../lib/run-status";

type TerminalDisplayState =
  | "completed"
  | "completed_with_warnings"
  | "approval_required"
  | "approval_denied"
  | "failed_tool"
  | "failed_runtime"
  | "failed_validation"
  | "failed_policy"
  | "interrupted"
  | "cancelled";

export interface RunTerminalSummaryLike {
  status: string | null;
  completedTasks?: number;
  failedTasks?: number;
  cancelledTasks?: number;
  terminalState?: string | null;
  terminalMessage?: Record<string, unknown> | null;
  pendingApproval?: unknown;
}

export interface RunTerminalViewModel {
  id: string;
  state: TerminalDisplayState;
  content: string;
  artifactId: string | null;
}

export function buildRunTerminalViewModel(input: {
  runId: string;
  summary: RunTerminalSummaryLike | null;
  events: RunEvent[];
  hasVisibleAssistantMessage: boolean;
  changedFileCount?: number;
}): RunTerminalViewModel | null {
  if (!input.summary || input.hasVisibleAssistantMessage) {
    return null;
  }

  const state = resolveTerminalDisplayState(input.summary);
  if (!state) {
    return null;
  }

  const terminalMetadata = readTerminalMetadata(input.summary);
  const changedFileCount =
    input.changedFileCount ??
    readNonNegativeInteger(terminalMetadata.changedFileCount);
  const lastSuccessfulStep =
    readNonEmptyString(terminalMetadata.lastSuccessfulStep) ??
    findLatestToolName(input.events, RUN_EVENT_TYPES.TOOL_COMPLETED);
  const failedStep =
    readNonEmptyString(terminalMetadata.failedStep) ??
    findLatestToolName(input.events, RUN_EVENT_TYPES.TOOL_FAILED);
  const nextAction =
    readNonEmptyString(terminalMetadata.nextAction) ??
    readNonEmptyString(terminalMetadata.resumeHint) ??
    resolveDefaultNextAction(state);
  const artifactId = readNonEmptyString(terminalMetadata.artifactId);
  if (
    isNoopCompletedTerminal({
      state,
      changedFileCount,
      artifactId,
      lastSuccessfulStep,
      failedStep,
    })
  ) {
    return null;
  }

  return {
    id: `terminal:${input.runId}`,
    state,
    artifactId,
    content: buildTerminalContent({
      state,
      changedFileCount,
      lastSuccessfulStep,
      failedStep,
      nextAction,
    }),
  };
}

function isNoopCompletedTerminal(input: {
  state: TerminalDisplayState;
  changedFileCount: number | null;
  artifactId: string | null;
  lastSuccessfulStep: string | null;
  failedStep: string | null;
}): boolean {
  if (input.state !== "completed") {
    return false;
  }

  return (
    input.changedFileCount === 0 &&
    !input.artifactId &&
    !input.lastSuccessfulStep &&
    !input.failedStep
  );
}

function resolveTerminalDisplayState(
  summary: RunTerminalSummaryLike,
): TerminalDisplayState | null {
  const terminalState = normalizeTerminalState(summary.terminalState);
  if (terminalState) {
    return terminalState;
  }

  if (summary.pendingApproval || isApprovalRequiredRunStatus(summary.status)) {
    return "approval_required";
  }

  const status = normalizeRunStatus(summary.status);
  if (status === "CANCELLED") {
    return "cancelled";
  }
  if (status === "FAILED") {
    return "failed_runtime";
  }
  if (status === "PAUSED") {
    return "interrupted";
  }
  if (status === "COMPLETED") {
    return "completed";
  }

  return isTerminalRunStatus(status) ? "completed" : null;
}

function normalizeTerminalState(
  value: string | null | undefined,
): TerminalDisplayState | null {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "completed":
    case "completed_with_warnings":
    case "approval_required":
    case "approval_denied":
    case "failed_tool":
    case "failed_runtime":
    case "failed_validation":
    case "failed_policy":
    case "interrupted":
    case "cancelled":
      return normalized;
    case "approval_resolved":
      return "approval_denied";
    default:
      return null;
  }
}

function readTerminalMetadata(
  summary: RunTerminalSummaryLike,
): Record<string, unknown> {
  return summary.terminalMessage ?? {};
}

function buildTerminalContent(input: {
  state: TerminalDisplayState;
  changedFileCount: number | null;
  lastSuccessfulStep: string | null;
  failedStep: string | null;
  nextAction: string;
}): string {
  const lines = [resolveOutcome(input.state)];

  if (input.changedFileCount !== null) {
    lines.push(`${formatChangedFileCount(input.changedFileCount)} changed.`);
  }
  if (input.lastSuccessfulStep) {
    lines.push(`Last successful step: ${input.lastSuccessfulStep}`);
  }
  if (input.failedStep) {
    lines.push(`Failed step: ${input.failedStep}`);
  }
  lines.push(input.nextAction);

  return lines.join("\n");
}

function resolveOutcome(state: TerminalDisplayState): string {
  switch (state) {
    case "completed":
      return "Run completed.";
    case "completed_with_warnings":
      return "Run completed with warnings.";
    case "approval_required":
      return "Approval is required before the run can continue.";
    case "approval_denied":
      return "The requested action was denied.";
    case "failed_tool":
      return "A required tool step failed.";
    case "failed_validation":
      return "The run failed validation.";
    case "failed_policy":
      return "Policy blocked the run.";
    case "interrupted":
      return "The run was interrupted before it completed.";
    case "cancelled":
      return "The run was cancelled.";
    case "failed_runtime":
    default:
      return "The runtime could not finish the run.";
  }
}

function resolveDefaultNextAction(state: TerminalDisplayState): string {
  switch (state) {
    case "completed":
      return "Send the next task when you are ready.";
    case "approval_required":
      return "Choose an approval action to continue.";
    case "approval_denied":
      return "Revise the request or approve a safer action.";
    case "cancelled":
    case "interrupted":
      return "Retry the request when you want to continue.";
    default:
      return "Review the completed work and retry the failed step.";
  }
}

function formatChangedFileCount(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

function findLatestToolName(
  events: RunEvent[],
  type:
    | typeof RUN_EVENT_TYPES.TOOL_COMPLETED
    | typeof RUN_EVENT_TYPES.TOOL_FAILED,
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) {
      return event.payload.toolName;
    }
  }
  return null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
