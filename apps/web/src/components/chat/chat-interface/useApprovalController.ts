import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ApprovalDecisionKind, ApprovalRequest } from "@repo/shared-types";
import {
  createLifecycleClient,
  type LifecycleClient,
} from "../../../services/api/lifecycleClient";
import type {
  LifecycleProjection,
  LifecycleProjectionApproval,
} from "../../../services/lifecycle/LifecycleProjection";
import { getDisplayedApprovalDecisions } from "../approval/approvalDecisions.js";
import {
  readApprovalErrorMessage,
  submitApprovalDecision,
} from "./approvals.js";

const APPROVAL_NOTICE_CLEAR_DELAY_MS = 5_000;
type ApprovalNotice = { kind: "resolved"; requestId: string } | null;

interface ApprovalControllerInput {
  runId: string;
  lifecycleProjection: LifecycleProjection | null;
  summaryPendingApproval?: ApprovalRequest | null;
  onPendingApprovalChange?: (hasPendingApproval: boolean) => void;
  lifecycleClient?: LifecycleClient;
}

type PendingApprovalState =
  | {
      source: "run-summary";
      request: ApprovalRequest;
    }
  | {
      source: "lifecycle";
      request: ApprovalRequest;
      approval: LifecycleProjectionApproval;
      turnId: LifecycleProjection["turnId"];
    };

export function useApprovalController(input: ApprovalControllerInput) {
  const lifecycleClient = useMemo(
    () => input.lifecycleClient ?? createLifecycleClient(),
    [input.lifecycleClient],
  );
  const [busyDecision, setBusyDecision] = useState<ApprovalDecisionKind | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ApprovalNotice>(null);
  const submittingRef = useRef(false);
  const pendingApprovalState = useMemo(
    () =>
      buildPendingApprovalState({
        lifecycleProjection: input.lifecycleProjection,
        summaryPendingApproval: input.summaryPendingApproval ?? null,
      }),
    [input.lifecycleProjection, input.summaryPendingApproval],
  );
  const pendingApproval = pendingApprovalState?.request ?? null;

  useApprovalLifecycle(
    pendingApproval,
    notice,
    input.onPendingApprovalChange,
    setNotice,
    setError,
  );

  const resolve = useCallback(
    (decision: ApprovalDecisionKind) =>
      resolveDecision({
        decision,
        runId: input.runId,
        lifecycleClient,
        pendingApprovalState,
        submittingRef,
        setBusyDecision,
        setError,
        setNotice,
      }),
    [
      input.lifecycleProjection,
      input.runId,
      lifecycleClient,
      pendingApprovalState,
    ],
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

function buildPendingApprovalState(input: {
  lifecycleProjection: LifecycleProjection | null;
  summaryPendingApproval: ApprovalRequest | null;
}): PendingApprovalState | null {
  if (input.summaryPendingApproval) {
    return {
      source: "run-summary",
      request: input.summaryPendingApproval,
    };
  }
  const lifecycle = buildLifecycleApprovalState(input.lifecycleProjection);
  return lifecycle;
}

function buildLifecycleApprovalState(
  projection: LifecycleProjection | null,
): PendingApprovalState | null {
  const approval = projection?.pendingApproval;
  if (!projection || !approval || approval.decision) {
    return null;
  }
  return {
    source: "lifecycle",
    approval,
    turnId: projection.turnId,
    request: {
      requestId: approval.approvalId,
      runId: projection.turnId,
      turnId: projection.turnId,
      itemId: approval.itemId,
      origin: "agent",
      category: "shell_command",
      title: approval.question,
      reason: approval.question,
      actionFingerprint: `${projection.turnId}:${approval.approvalId}`,
      availableDecisions: getCanonicalApprovalDecisions(approval),
      createdAt: approval.requestedAt,
    },
  };
}

function getCanonicalApprovalDecisions(
  approval: LifecycleProjectionApproval,
): ApprovalDecisionKind[] {
  const optionText = approval.options.join(" ").toLowerCase();
  if (optionText.includes("cancel") || optionText.includes("abort")) {
    return ["allow_once", "deny", "abort"];
  }
  return ["allow_once", "deny"];
}

function useApprovalLifecycle(
  pending: ApprovalRequest | null,
  notice: ApprovalNotice,
  onPendingChange: ApprovalControllerInput["onPendingApprovalChange"],
  setNotice: Dispatch<SetStateAction<ApprovalNotice>>,
  setError: Dispatch<SetStateAction<string | null>>,
) {
  useEffect(() => {
    setError(null);
  }, [pending?.requestId, setError]);
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

interface ResolveDecisionInput {
  readonly decision: ApprovalDecisionKind;
  readonly runId: string;
  readonly lifecycleClient: LifecycleClient;
  readonly pendingApprovalState: PendingApprovalState | null;
  readonly submittingRef: MutableRefObject<boolean>;
  readonly setBusyDecision: Dispatch<
    SetStateAction<ApprovalDecisionKind | null>
  >;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly setNotice: Dispatch<SetStateAction<ApprovalNotice>>;
}

async function resolveDecision(input: ResolveDecisionInput): Promise<void> {
  if (input.submittingRef.current || !input.pendingApprovalState) {
    return;
  }
  const pendingApproval = input.pendingApprovalState.request;
  input.submittingRef.current = true;
  input.setBusyDecision(input.decision);
  input.setError(null);
  input.setNotice(null);
  try {
    if (input.pendingApprovalState.source === "lifecycle") {
      await input.lifecycleClient.submitApproval({
        turnId: input.pendingApprovalState.turnId,
        approvalId: input.pendingApprovalState.approval.approvalId,
        decision: mapApprovalDecision(input.decision),
        decidedBy: null,
        reason: null,
      });
    } else {
      const response = await submitApprovalDecision({
        runId: pendingApproval.runId || input.runId,
        requestId: pendingApproval.requestId,
        decision: input.decision,
      });
      if (!response.ok) {
        throw new Error(await readApprovalErrorMessage(response));
      }
    }
    input.setNotice({
      kind: "resolved",
      requestId: pendingApproval.requestId,
    });
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

function mapApprovalDecision(
  decision: ApprovalDecisionKind,
): "approved" | "denied" | "cancelled" {
  switch (decision) {
    case "deny":
      return "denied";
    case "abort":
      return "cancelled";
    case "allow_once":
    case "allow_for_run":
    case "allow_persistent_rule":
      return "approved";
  }
}

function getApprovalNoticeText(notice: ApprovalNotice): string | null {
  return notice ? "Approval recorded. Continuing..." : null;
}
