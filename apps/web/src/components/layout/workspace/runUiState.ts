import {
  isApprovalRequiredRunStatus,
  isTerminalRunStatus,
} from "../../../lib/run-status";

interface WorkspaceRunMessage {
  role?: string;
  content?: unknown;
}

export type WorkspaceRunUiStateKind =
  | "approval_waiting"
  | "active"
  | "stale_completed"
  | "terminal"
  | "idle";

export interface WorkspaceRunUiState {
  kind: WorkspaceRunUiStateKind;
  hasPendingApproval: boolean;
  hasLocalAssistantCompletion: boolean;
  isCanonicalRunTerminal: boolean;
  isApprovalWaitingRun: boolean;
  isStaleCanonicalActiveRun: boolean;
  isEffectiveCanonicalRunActive: boolean;
  isRunLoading: boolean;
  canStopRun: boolean;
}

export interface DeriveWorkspaceRunUiStateInput {
  canonicalRunStatus: string | null;
  hasPendingApproval: boolean;
  isChatLoading: boolean;
  isSessionRunning: boolean;
  isLocallyStoppedRun: boolean;
  lastMessage: WorkspaceRunMessage | undefined;
}

export function deriveWorkspaceRunUiState(
  input: DeriveWorkspaceRunUiStateInput,
): WorkspaceRunUiState {
  const baseState = deriveWorkspaceRunBaseState(input);
  const isRunLoading =
    input.isChatLoading ||
    baseState.isEffectiveCanonicalRunActive ||
    baseState.isSessionActiveWithoutSummary;
  return {
    ...baseState,
    kind: deriveWorkspaceRunUiStateKind(baseState, isRunLoading),
    isRunLoading,
    canStopRun: deriveCanStopRun(input, baseState, isRunLoading),
  };
}

function deriveWorkspaceRunBaseState(input: DeriveWorkspaceRunUiStateInput) {
  const hasLocalAssistantCompletion = hasAssistantCompletion(input);
  const isCanonicalRunActive =
    input.canonicalRunStatus === "RUNNING" ||
    input.canonicalRunStatus === "CREATED";
  const isCanonicalRunTerminal = isTerminalRunStatus(input.canonicalRunStatus);
  const isApprovalWaitingRun =
    input.hasPendingApproval ||
    isApprovalRequiredRunStatus(input.canonicalRunStatus);
  const isStaleCanonicalActiveRun =
    isCanonicalRunActive && hasLocalAssistantCompletion;
  const isEffectiveCanonicalRunActive =
    isCanonicalRunActive &&
    !isStaleCanonicalActiveRun &&
    !input.isLocallyStoppedRun &&
    !isApprovalWaitingRun;

  return {
    hasPendingApproval: input.hasPendingApproval,
    hasLocalAssistantCompletion,
    isCanonicalRunTerminal,
    isApprovalWaitingRun,
    isStaleCanonicalActiveRun,
    isEffectiveCanonicalRunActive,
    isSessionActiveWithoutSummary: deriveSessionActiveWithoutSummary(
      input,
      hasLocalAssistantCompletion,
      isCanonicalRunTerminal,
      isApprovalWaitingRun,
    ),
  };
}

function hasAssistantCompletion(input: DeriveWorkspaceRunUiStateInput) {
  const content = input.lastMessage?.content;
  return (
    !input.isChatLoading &&
    input.lastMessage?.role === "assistant" &&
    typeof content === "string" &&
    content.trim().length > 0 &&
    !input.hasPendingApproval
  );
}

function deriveSessionActiveWithoutSummary(
  input: DeriveWorkspaceRunUiStateInput,
  hasLocalAssistantCompletion: boolean,
  isCanonicalRunTerminal: boolean,
  isApprovalWaitingRun: boolean,
): boolean {
  return (
    input.isSessionRunning &&
    !isCanonicalRunTerminal &&
    !hasLocalAssistantCompletion &&
    !input.isLocallyStoppedRun &&
    !isApprovalWaitingRun
  );
}

function deriveCanStopRun(
  input: DeriveWorkspaceRunUiStateInput,
  state: ReturnType<typeof deriveWorkspaceRunBaseState>,
  isRunLoading: boolean,
): boolean {
  return (
    !input.isLocallyStoppedRun &&
    (state.isApprovalWaitingRun ||
      isRunLoading ||
      (input.isSessionRunning &&
        !state.isCanonicalRunTerminal &&
        !state.isStaleCanonicalActiveRun))
  );
}

function deriveWorkspaceRunUiStateKind(
  state: ReturnType<typeof deriveWorkspaceRunBaseState>,
  isRunLoading: boolean,
): WorkspaceRunUiStateKind {
  if (state.isApprovalWaitingRun) {
    return "approval_waiting";
  }
  if (state.isStaleCanonicalActiveRun) {
    return "stale_completed";
  }
  if (isRunLoading) {
    return "active";
  }
  if (state.isCanonicalRunTerminal) {
    return "terminal";
  }
  return "idle";
}
