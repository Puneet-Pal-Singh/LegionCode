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
import { ApprovalIdSchema } from "@repo/platform-client-sdk";
import {
  createLifecycleClient,
  type LifecycleClient,
} from "../../../services/api/lifecycleClient";
import type {
  LifecycleProjection,
  LifecycleProjectionApproval,
} from "../../../services/lifecycle/LifecycleProjection";
import { getDisplayedApprovalDecisions } from "../approval/approvalDecisions.js";

interface ApprovalControllerInput {
  lifecycleProjection: LifecycleProjection | null;
  sessionId: string;
  lifecycleClient?: LifecycleClient;
}

type PendingApprovalState = {
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
  const [resolvedRequestId, setResolvedRequestId] = useState<string | null>(
    null,
  );
  const submittingRef = useRef(false);
  const pendingApprovalState = useMemo(
    () =>
      buildPendingApprovalState({
        lifecycleProjection: input.lifecycleProjection,
      }),
    [input.lifecycleProjection],
  );
  const projectedApproval = pendingApprovalState?.request ?? null;
  const approvalIdentity = projectedApproval
    ? `${input.sessionId}:${projectedApproval.turnId}:${projectedApproval.requestId}`
    : null;
  const pendingApproval =
    approvalIdentity === resolvedRequestId
      ? null
      : projectedApproval;

  useApprovalLifecycle(
    projectedApproval,
    input.sessionId,
    setResolvedRequestId,
    setError,
  );

  const resolve = useCallback(
    (decision: ApprovalDecisionKind) =>
      resolveDecision({
        decision,
        lifecycleClient,
        pendingApprovalState,
        submittingRef,
        setBusyDecision,
        setError,
        setResolvedRequestId,
        resolvedApprovalIdentity: approvalIdentity,
      }),
    [approvalIdentity, lifecycleClient, pendingApprovalState],
  );

  return {
    pendingApproval,
    decisions: getDisplayedApprovalDecisions(pendingApproval),
    busyDecision,
    error,
    resolve,
  };
}

function buildPendingApprovalState(input: {
  lifecycleProjection: LifecycleProjection | null;
}): PendingApprovalState | null {
  return buildLifecycleApprovalState(input.lifecycleProjection);
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
  projected: ApprovalRequest | null,
  sessionId: string,
  setResolvedRequestId: Dispatch<SetStateAction<string | null>>,
  setError: Dispatch<SetStateAction<string | null>>,
) {
  const approvalIdentity = projected
    ? `${sessionId}:${projected.turnId}:${projected.requestId}`
    : null;
  useEffect(() => {
    setError(null);
  }, [approvalIdentity, setError]);
  useEffect(() => {
    if (!projected) {
      setResolvedRequestId(null);
    }
  }, [projected, setResolvedRequestId]);
}

interface ResolveDecisionInput {
  readonly decision: ApprovalDecisionKind;
  readonly lifecycleClient: LifecycleClient;
  readonly pendingApprovalState: PendingApprovalState | null;
  readonly submittingRef: MutableRefObject<boolean>;
  readonly setBusyDecision: Dispatch<
    SetStateAction<ApprovalDecisionKind | null>
  >;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly setResolvedRequestId: Dispatch<SetStateAction<string | null>>;
  readonly resolvedApprovalIdentity: string | null;
}

async function resolveDecision(input: ResolveDecisionInput): Promise<void> {
  if (input.submittingRef.current || !input.pendingApprovalState) {
    return;
  }
  input.submittingRef.current = true;
  input.setBusyDecision(input.decision);
  input.setError(null);
  try {
    if (input.pendingApprovalState.source === "lifecycle") {
      await input.lifecycleClient.submitApproval({
        turnId: input.pendingApprovalState.turnId,
        approvalId: ApprovalIdSchema.parse(
          input.pendingApprovalState.approval.approvalId,
        ),
        decision: mapApprovalDecision(input.decision),
        decidedBy: null,
        reason: null,
      });
    }
    if (input.resolvedApprovalIdentity) {
      input.setResolvedRequestId(input.resolvedApprovalIdentity);
    }
  } catch (error) {
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
