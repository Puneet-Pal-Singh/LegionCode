import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { SessionStatus } from "../../../types/session";

interface UseStatusSyncProps {
  activeRunId: string;
  canonicalRunStatus: string | null;
  isApprovalWaitingRun: boolean;
  pendingApprovalRequestId: string | null;
  isStaleCanonicalActiveRun: boolean;
  isEffectiveCanonicalRunActive: boolean;
  isLoading: boolean;
  chatError: string | null;
  hasPendingApproval: boolean;
  isLocallyStoppedRun: boolean;
  setLocallyStoppedRunId: (runId: string | null) => void;
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
  isStaleCanonicalActiveRun,
  isEffectiveCanonicalRunActive,
  isLoading,
  chatError,
  hasPendingApproval,
  isLocallyStoppedRun,
  setLocallyStoppedRunId,
  stop,
  refetchGitStatus,
  onSessionStatusChange,
}: UseStatusSyncProps): UseStatusSyncResult {
  const previousChatLoadingRef = useRef(false);
  const lastAppliedCanonicalStatusRef = useRef<{
    runId: string;
    status: string;
    requestId?: string | null;
  } | null>(null);
  const lastAppliedChatErrorRef = useRef<{
    runId: string;
    error: string;
  } | null>(null);
  const stateAtStopRef = useRef<{
    hasPendingApproval: boolean;
    chatError: string | null;
  }>({ hasPendingApproval: false, chatError: null });

  const handleStopRun = useCallback(() => {
    setLocallyStoppedRunId(activeRunId);
    stop();
    onSessionStatusChange?.("completed");
  }, [activeRunId, onSessionStatusChange, setLocallyStoppedRunId, stop]);

  useEffect(() => {
    stateAtStopRef.current = {
      hasPendingApproval,
      chatError,
    };
  }, [hasPendingApproval, chatError]);

  useEffect(() => {
    const wasLoading = previousChatLoadingRef.current;
    previousChatLoadingRef.current = isLoading;
    if (!wasLoading && isLoading) {
      onSessionStatusChange?.("running");
      return;
    }
    if (wasLoading && !isLoading && !isApprovalWaitingRun) {
      const snapshot = stateAtStopRef.current;
      const terminal = snapshot.hasPendingApproval
        ? "waiting_for_approval"
        : snapshot.chatError
          ? "failed"
          : "completed";
      onSessionStatusChange?.(terminal);
      void refetchGitStatus(true);
    }
  }, [
    isApprovalWaitingRun,
    isLoading,
    onSessionStatusChange,
    refetchGitStatus,
  ]);

  useEffect(() => {
    if (isLoading) setLocallyStoppedRunId(null);
  }, [isLoading, setLocallyStoppedRunId]);

  useEffect(() => {
    setLocallyStoppedRunId(null);
  }, [activeRunId, setLocallyStoppedRunId]);

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
    if (isStaleCanonicalActiveRun) {
      applyCanonicalStatus(
        lastAppliedCanonicalStatusRef,
        activeRunId,
        "LOCAL_COMPLETED",
        () => {
          onSessionStatusChange?.("completed");
          void refetchGitStatus(true);
        },
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
          isLocallyStoppedRun,
          onSessionStatusChange,
          refetchGitStatus,
          setLocallyStoppedRunId,
        }),
    );
  }, [
    activeRunId,
    canonicalRunStatus,
    isApprovalWaitingRun,
    isLocallyStoppedRun,
    isStaleCanonicalActiveRun,
    onSessionStatusChange,
    pendingApprovalRequestId,
    refetchGitStatus,
    setLocallyStoppedRunId,
  ]);

  useEffect(() => {
    if (
      !chatError ||
      isLoading ||
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
    isLoading,
    onSessionStatusChange,
  ]);

  return { handleStopRun };
}

interface DispatchCanonicalStatusArgs {
  canonicalRunStatus: string;
  isLocallyStoppedRun: boolean;
  onSessionStatusChange?: (status: SessionStatus) => void;
  refetchGitStatus: (force?: boolean) => Promise<unknown>;
  setLocallyStoppedRunId: (runId: string | null) => void;
}

function dispatchCanonicalStatus({
  canonicalRunStatus,
  isLocallyStoppedRun,
  onSessionStatusChange,
  refetchGitStatus,
  setLocallyStoppedRunId,
}: DispatchCanonicalStatusArgs): void {
  if (canonicalRunStatus === "RUNNING" || canonicalRunStatus === "CREATED") {
    if (!isLocallyStoppedRun) onSessionStatusChange?.("running");
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
    if (canonicalRunStatus === "CANCELLED") setLocallyStoppedRunId(null);
    onSessionStatusChange?.("completed");
    void refetchGitStatus(true);
  }
}
