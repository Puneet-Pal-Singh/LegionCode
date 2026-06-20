import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  RunEvent,
} from "@repo/shared-types";
import {
  isApprovalRequiredRunStatus,
  isTerminalRunStatus,
} from "../../../lib/run-status.js";
import { dispatchRunSummaryRefresh } from "../../../lib/run-summary-events.js";
import { getDisplayedApprovalDecisions } from "../approval/approvalDecisions.js";
import {
  derivePendingApprovalFromEvents,
  fetchLatestPendingApproval,
  isNoPendingApprovalError,
  readApprovalErrorMessage,
  submitApprovalDecision,
} from "./approvals";

const APPROVAL_NOTICE_CLEAR_DELAY_MS = 5_000;
type ApprovalNotice = { kind: "resolved" | "stale"; requestId: string } | null;

interface ApprovalSummary {
  status: string | null;
  pendingApproval?: ApprovalRequest | null;
}

interface ApprovalControllerInput {
  runId: string;
  summary: ApprovalSummary | null;
  events: RunEvent[];
  onPendingApprovalChange?: (hasPendingApproval: boolean) => void;
}

export function useApprovalController(input: ApprovalControllerInput) {
  const [busyDecision, setBusyDecision] = useState<ApprovalDecisionKind | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ApprovalNotice>(null);
  const [dismissed, setDismissed] = useState<{
    requestId: string;
    createdAt: string;
  } | null>(null);
  const submittingRef = useRef(false);
  const eventApproval = useMemo(
    () => derivePendingApprovalFromEvents(input.events),
    [input.events],
  );
  const candidate = useMemo(
    () => resolveApprovalCandidate(input.summary, eventApproval, input.events),
    [eventApproval, input.events, input.summary],
  );
  const pendingApproval =
    candidate && !isSameApproval(candidate, dismissed) ? candidate : null;

  useApprovalLifecycle(
    candidate,
    pendingApproval,
    dismissed,
    notice,
    input.onPendingApprovalChange,
    setDismissed,
    setNotice,
    setError,
  );
  const resolve = useCallback(
    (decision: ApprovalDecisionKind) =>
      resolveDecision({
        ...input,
        decision,
        eventApproval,
        dismissed,
        submittingRef,
        setBusyDecision,
        setError,
        setNotice,
        setDismissed,
      }),
    [dismissed, eventApproval, input],
  );

  return {
    pendingApproval,
    decisions: getDisplayedApprovalDecisions(pendingApproval),
    busyDecision,
    error,
    notice: getApprovalNoticeText(notice),
    isResolutionPending:
      notice?.kind === "resolved" &&
      pendingApproval?.requestId === notice.requestId,
    resolve,
  };
}

function resolveApprovalCandidate(
  summary: ApprovalSummary | null,
  eventApproval: ApprovalRequest | null,
  events: RunEvent[],
): ApprovalRequest | null {
  if (!summary) return eventApproval;
  if (
    summary.pendingApproval &&
    !hasResolvedApprovalEvent(events, summary.pendingApproval.requestId)
  ) {
    return summary.pendingApproval;
  }
  const terminal = isTerminalRunStatus(summary.status);
  const waiting = isApprovalRequiredRunStatus(summary.status);
  return terminal && !waiting ? null : eventApproval;
}

function hasResolvedApprovalEvent(
  events: RunEvent[],
  requestId: string,
): boolean {
  return events.some(
    (event) =>
      event.type === "approval.resolved" &&
      event.payload.requestId === requestId,
  );
}

function useApprovalLifecycle(
  candidate: ApprovalRequest | null,
  pending: ApprovalRequest | null,
  dismissed: { requestId: string; createdAt: string } | null,
  notice: ApprovalNotice,
  onPendingChange: ApprovalControllerInput["onPendingApprovalChange"],
  setDismissed: React.Dispatch<
    React.SetStateAction<{ requestId: string; createdAt: string } | null>
  >,
  setNotice: React.Dispatch<React.SetStateAction<ApprovalNotice>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
) {
  useEffect(() => {
    if (!candidate) {
      setDismissed(null);
      setNotice(null);
      return;
    }
    if (dismissed && !isSameApproval(candidate, dismissed)) {
      setDismissed(null);
      setError(null);
    }
    if (notice && candidate.requestId !== notice.requestId) setNotice(null);
  }, [candidate, dismissed, notice, setDismissed, setError, setNotice]);
  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(
      () =>
        setNotice((current) =>
          current?.kind === notice.kind &&
          current.requestId === notice.requestId
            ? null
            : current,
        ),
      APPROVAL_NOTICE_CLEAR_DELAY_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [notice, setNotice]);
  useEffect(
    () => onPendingChange?.(Boolean(pending)),
    [onPendingChange, pending],
  );
}

interface ResolveDecisionInput extends ApprovalControllerInput {
  decision: ApprovalDecisionKind;
  eventApproval: ApprovalRequest | null;
  dismissed: { requestId: string; createdAt: string } | null;
  submittingRef: React.MutableRefObject<boolean>;
  setBusyDecision: React.Dispatch<
    React.SetStateAction<ApprovalDecisionKind | null>
  >;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setNotice: React.Dispatch<React.SetStateAction<ApprovalNotice>>;
  setDismissed: React.Dispatch<
    React.SetStateAction<{ requestId: string; createdAt: string } | null>
  >;
}

async function resolveDecision(input: ResolveDecisionInput): Promise<void> {
  if (input.submittingRef.current) return;
  const pending = input.summary?.pendingApproval ?? input.eventApproval;
  if (!pending || isSameApproval(pending, input.dismissed)) return;
  input.submittingRef.current = true;
  input.setBusyDecision(input.decision);
  input.setError(null);
  input.setNotice(null);
  try {
    await submitOrRecover(input, pending);
  } catch (error) {
    input.setNotice(null);
    input.setError(
      error instanceof Error
        ? error.message
        : "Failed to resolve approval request.",
    );
  } finally {
    input.submittingRef.current = false;
    input.setBusyDecision(null);
  }
}

async function submitOrRecover(
  input: ResolveDecisionInput,
  pending: ApprovalRequest,
): Promise<void> {
  const response = await submitApprovalDecision({
    runId: input.runId,
    requestId: pending.requestId,
    decision: input.decision,
  });
  if (response.ok) {
    markResolved(input, pending.requestId);
    return;
  }
  const message = await readApprovalErrorMessage(response);
  if (response.status !== 409 && !isNoPendingApprovalError(message))
    throw new Error(
      message || `Failed to resolve approval (${response.status})`,
    );
  const latest = await fetchLatestPendingApproval(input.runId);
  if (
    latest &&
    latest.requestId !== pending.requestId &&
    latest.availableDecisions.includes(input.decision)
  ) {
    await retryLatestApproval(input, latest);
    return;
  }
  markStale(input, pending);
}

async function retryLatestApproval(
  input: ResolveDecisionInput,
  latest: ApprovalRequest,
): Promise<void> {
  const response = await submitApprovalDecision({
    runId: input.runId,
    requestId: latest.requestId,
    decision: input.decision,
  });
  if (response.ok) {
    markResolved(input, latest.requestId);
    return;
  }
  const message = await readApprovalErrorMessage(response);
  if (response.status === 409 || isNoPendingApprovalError(message)) {
    markStale(input, latest);
    return;
  }
  throw new Error(message || `Failed to resolve approval (${response.status})`);
}

function markResolved(input: ResolveDecisionInput, requestId: string): void {
  input.setNotice({ kind: "resolved", requestId });
  dispatchRunSummaryRefresh(input.runId);
}

function markStale(
  input: ResolveDecisionInput,
  request: ApprovalRequest,
): void {
  input.setDismissed({
    requestId: request.requestId,
    createdAt: request.createdAt,
  });
  input.setNotice({ kind: "stale", requestId: request.requestId });
  dispatchRunSummaryRefresh(input.runId);
}

function isSameApproval(
  request: ApprovalRequest,
  other: { requestId: string; createdAt: string } | null,
): boolean {
  return Boolean(
    other &&
    request.requestId === other.requestId &&
    request.createdAt === other.createdAt,
  );
}

function getApprovalNoticeText(notice: ApprovalNotice): string | null {
  if (!notice) return null;
  return notice.kind === "resolved"
    ? "Approval recorded. Continuing..."
    : "Approval request is no longer pending.";
}
