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
  onPendingApprovalChange?: (hasPendingApproval: boolean) => void;
  lifecycleClient?: LifecycleClient;
}

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
  const pendingApproval = useMemo(
    () => buildLifecycleApprovalRequest(input.lifecycleProjection),
    [input.lifecycleProjection],
  );

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
        projection: input.lifecycleProjection,
        pendingApproval,
        submittingRef,
        setBusyDecision,
        setError,
        setNotice,
      }),
    [input.lifecycleProjection, input.runId, lifecycleClient, pendingApproval],
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

function buildLifecycleApprovalRequest(
  projection: LifecycleProjection | null,
): ApprovalRequest | null {
  const approval = projection?.pendingApproval;
  if (!projection || !approval || approval.decision) {
    return null;
  }
  return {
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
  readonly projection: LifecycleProjection | null;
  readonly pendingApproval: ApprovalRequest | null;
  readonly submittingRef: MutableRefObject<boolean>;
  readonly setBusyDecision: Dispatch<
    SetStateAction<ApprovalDecisionKind | null>
  >;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly setNotice: Dispatch<SetStateAction<ApprovalNotice>>;
}

async function resolveDecision(input: ResolveDecisionInput): Promise<void> {
  const canonicalApproval = input.projection?.pendingApproval;
  if (input.submittingRef.current || !input.pendingApproval) {
    return;
  }
  input.submittingRef.current = true;
  input.setBusyDecision(input.decision);
  input.setError(null);
  input.setNotice(null);
  try {
    if (input.projection && canonicalApproval) {
      await input.lifecycleClient.submitApproval({
        turnId: input.projection.turnId,
        approvalId: canonicalApproval.approvalId,
        decision: mapApprovalDecision(input.decision),
        decidedBy: null,
        reason: null,
      });
    } else {
      const response = await submitApprovalDecision({
        runId: input.pendingApproval.runId || input.runId,
        requestId: input.pendingApproval.requestId,
        decision: input.decision,
      });
      if (!response.ok) {
        throw new Error(await readApprovalErrorMessage(response));
      }
    }
    input.setNotice({
      kind: "resolved",
      requestId: input.pendingApproval.requestId,
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
