import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { SessionStatus } from "../../../types/session";

interface UseStatusSyncProps {
  activeRunId: string;
  canonicalRunStatus: string | null;
  isApprovalWaitingRun: boolean;
  pendingApprovalRequestId: string | null;
  isEffectiveCanonicalRunActive: boolean;
  chatError: string | null;
  stop: () => void;
  refetchGitStatus: (force?: boolean) => Promise<unknown>;
  onSessionStatusChange?: (status: SessionStatus) => void;
}

export interface UseStatusSyncResult {
  handleStopRun: () => void;
}

type AppliedRunStatusRef = MutableRefObject<{
  runId: string;
  status: string;
  requestId?: string | null;
} | null>;

type AppliedRunErrorRef = MutableRefObject<{
  runId: string;
  error: string;
} | null>;

function applyCanonicalStatus(
  ref: AppliedRunStatusRef,
  runId: string,
  status: string,
  apply: () => void,
  requestId?: string | null,
): void {
  const last = ref.current;
  if (
    last &&
    last.runId === runId &&
    last.status === status &&
    (requestId === undefined || last.requestId === requestId)
  ) {
    return;
  }
  ref.current = { runId, status, requestId };
  apply();
}

function applyChatError(
  ref: AppliedRunErrorRef,
  runId: string,
  error: string,
  apply: () => void,
): void {
  const last = ref.current;
  if (last && last.runId === runId && last.error === error) return;
  ref.current = { runId, error };
  apply();
}

export function useStatusSync({
  activeRunId,
  canonicalRunStatus,
  isApprovalWaitingRun,
  pendingApprovalRequestId,
  isEffectiveCanonicalRunActive,
  chatError,
  stop,
  refetchGitStatus,
  onSessionStatusChange,
}: UseStatusSyncProps): UseStatusSyncResult {
  const lastAppliedCanonicalStatusRef = useRef<{
    runId: string;
    status: string;
    requestId?: string | null;
  } | null>(null);
  const lastAppliedChatErrorRef = useRef<{
    runId: string;
    error: string;
  } | null>(null);

  const handleStopRun = useCallback(() => {
    stop();
  }, [stop]);

  useEffect(() => {
    if (!canonicalRunStatus) return;
    if (isApprovalWaitingRun) {
      applyCanonicalStatus(
        lastAppliedCanonicalStatusRef,
        activeRunId,
        "APPROVAL_WAITING",
        () => {
          onSessionStatusChange?.("waiting_for_approval");
          void refetchGitStatus(true);
        },
        pendingApprovalRequestId,
      );
      return;
    }
    applyCanonicalStatus(
      lastAppliedCanonicalStatusRef,
      activeRunId,
      canonicalRunStatus,
      () =>
        dispatchCanonicalStatus({
          canonicalRunStatus,
          onSessionStatusChange,
          refetchGitStatus,
        }),
    );
  }, [
    activeRunId,
    canonicalRunStatus,
    isApprovalWaitingRun,
    onSessionStatusChange,
    pendingApprovalRequestId,
    refetchGitStatus,
  ]);

  useEffect(() => {
    if (
      !chatError ||
      isEffectiveCanonicalRunActive ||
      isApprovalWaitingRun
    ) {
      return;
    }
    applyChatError(lastAppliedChatErrorRef, activeRunId, chatError, () => {
      onSessionStatusChange?.("failed");
    });
  }, [
    activeRunId,
    chatError,
    isEffectiveCanonicalRunActive,
    isApprovalWaitingRun,
    onSessionStatusChange,
  ]);

  return { handleStopRun };
}

interface DispatchCanonicalStatusArgs {
  canonicalRunStatus: string;
  onSessionStatusChange?: (status: SessionStatus) => void;
  refetchGitStatus: (force?: boolean) => Promise<unknown>;
}

function dispatchCanonicalStatus({
  canonicalRunStatus,
  onSessionStatusChange,
  refetchGitStatus,
}: DispatchCanonicalStatusArgs): void {
  if (canonicalRunStatus === "RUNNING" || canonicalRunStatus === "CREATED") {
    onSessionStatusChange?.("running");
    return;
  }
  if (canonicalRunStatus === "PAUSED") {
    onSessionStatusChange?.("paused");
    void refetchGitStatus(true);
    return;
  }
  if (canonicalRunStatus === "FAILED") {
    onSessionStatusChange?.("failed");
    void refetchGitStatus(true);
    return;
  }
  if (
    canonicalRunStatus === "COMPLETED" ||
    canonicalRunStatus === "CANCELLED"
  ) {
    onSessionStatusChange?.("completed");
    void refetchGitStatus(true);
  }
}
