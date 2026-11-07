import type {
  LifecycleEventStore,
  TurnAdmissionRecord,
} from "@repo/persistence";
import {
  TurnIdSchema,
  workspaceIdFromExternalId,
  userIdFromExternalId,
  type UserId,
  type ApprovalDecision,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import type { RunInterruptIdentity } from "./RunInterruptContract";

type Requested = Extract<LifecycleEvent, { type: "approval.requested" }>;
type Decided = Extract<LifecycleEvent, { type: "approval.decided" }>;
type Scope = RunInterruptIdentity & {
  readonly ownerUserId?: string;
  readonly revisionOfTurnId?: string;
};
type ApprovalAuthorization =
  | {
      readonly kind: "pending";
      readonly scope: Scope;
      readonly decidedBy: UserId;
    }
  | { readonly kind: "decided"; readonly event: Decided }
  | { readonly kind: "conflict"; readonly message: string };

/** The hosted caller has authenticated run ownership. Bind its command to the
 * immutable admission and canonical request, never the Native allowance store.
 * The registered kernel remains the single winner/append authority and checks
 * the private harness origin and current credential generation before delivery. */
export async function authorizeLifecycleApproval(input: {
  readonly store: LifecycleEventStore;
  readonly turnId: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  readonly grantScope?: "once" | "matching_in_chat";
  readonly identity: Scope | undefined;
  readonly admission: TurnAdmissionRecord | null;
  readonly hasActiveOwner: () => boolean;
}): Promise<ApprovalAuthorization> {
  const { identity, admission } = input;
  if (
    !identity ||
    !admission ||
    admission.state !== "admitted" ||
    !identity.ownerUserId ||
    admission.userId !== identity.ownerUserId ||
    admission.turnId !== input.turnId ||
    identity.turnId !== input.turnId ||
    admission.runId !== input.runId ||
    identity.runId !== input.runId ||
    admission.sessionId !== identity.sessionId ||
    admission.workspaceId !== identity.workspaceId ||
    admission.threadId !== identity.threadId ||
    admission.runAttemptId !== identity.runAttemptId ||
    admission.revisionOfTurnId !== (identity.revisionOfTurnId ?? null)
  ) {
    return conflict(
      "Approval does not match its immutable admitted runtime scope.",
    );
  }
  const approval = await findLifecycleApprovalEvents(
    input.store,
    identity,
    input.approvalId,
  );
  if (!approval.requested || approval.unavailable) {
    return conflict("No matching canonical approval request is available.");
  }
  if (approval.decided) {
    return isMatchingLifecycleApprovalDecision(
      approval.decided,
      input.decision,
      input.grantScope,
    )
      ? { kind: "decided", event: approval.decided }
      : conflict("Approval request was already resolved differently.");
  }
  if (
    approval.settled ||
    admission.executionState !== "running" ||
    !input.hasActiveOwner()
  ) {
    return conflict(
      "Approval cannot be resolved because its runtime request is no longer active.",
    );
  }
  if (
    input.grantScope === "matching_in_chat" &&
    !isMatchingInChatGrantRequest(
      approval.requested,
      workspaceIdFromExternalId(identity.workspaceId),
    )
  ) {
    return conflict(
      "This approval request does not allow a matching-in-chat grant.",
    );
  }
  return {
    kind: "pending",
    scope: identity,
    decidedBy: userIdFromExternalId(identity.ownerUserId),
  };
}

/** Read through the existing canonical store; no request state is persisted here. */
export async function findLifecycleApprovalEvents(
  store: LifecycleEventStore,
  scope: RunInterruptIdentity,
  approvalId: string,
): Promise<{
  requested: Requested | null;
  decided: Decided | null;
  settled: boolean;
  unavailable: boolean;
}> {
  let afterSequence: number | null = null;
  let requested: Requested | null = null;
  let decided: Decided | null = null;
  let settled = false;
  let unavailable = false;
  for (;;) {
    const replay = await store.replay({
      turnId: TurnIdSchema.parse(scope.turnId),
      afterSequence,
      limit: 1_000,
    });
    for (const event of replay.events) {
      if (
        event.turnId !== scope.turnId ||
        event.threadId !== scope.threadId ||
        event.runAttemptId !== scope.runAttemptId
      ) {
        unavailable = true;
        continue;
      }
      if (
        event.type === "approval.requested" &&
        event.approvalId === approvalId
      ) {
        if (requested || decided || settled) unavailable = true;
        requested = event;
      } else if (
        event.type === "approval.decided" &&
        event.approvalId === approvalId
      ) {
        if (!requested || decided || event.itemId !== requested.itemId)
          unavailable = true;
        decided = event;
      } else if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted" ||
        (requested &&
          "itemId" in event &&
          event.itemId === requested.itemId &&
          (event.type === "request.resolved" ||
            event.type === "item.completed" ||
            event.type === "item.failed" ||
            event.type === "item.interrupted" ||
            event.type === "item.declined"))
      ) {
        settled = true;
      }
    }
    if (replay.nextSequence === null) break;
    if (
      replay.events.length === 0 ||
      replay.nextSequence <= (afterSequence ?? 0)
    ) {
      throw new Error("Canonical approval replay cursor did not advance");
    }
    afterSequence = replay.nextSequence;
  }
  return { requested, decided, settled, unavailable };
}

function isMatchingInChatGrantRequest(
  event: Requested,
  workspaceId: string,
): boolean {
  const { options, metadata } = event.payload;
  if (
    !Array.isArray(options) ||
    !options.some(
      (option) =>
        typeof option === "object" &&
        option !== null &&
        "id" in option &&
        option.id === "allow_matching_in_chat",
    )
  )
    return false;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    typeof metadata.grantMatcherKey === "string" &&
    metadata.grantMatcherKey.length > 0 &&
    metadata.grantWorkspaceId === workspaceId
  );
}

function isMatchingLifecycleApprovalDecision(
  event: Decided,
  decision: ApprovalDecision,
  grantScope?: "once" | "matching_in_chat",
): boolean {
  return (
    event.payload.status === decision &&
    (event.payload.grantScope ?? "once") === (grantScope ?? "once")
  );
}

function conflict(message: string): ApprovalAuthorization {
  return { kind: "conflict", message };
}
