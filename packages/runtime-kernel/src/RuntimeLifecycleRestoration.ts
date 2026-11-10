import type { ItemId, ToolCallBatchId } from "@repo/platform-protocol";
import {
  LifecycleTransitionError, ItemKindSchema, TurnBlockingStateSchema,
  assertNextLifecycleSequence, assertTurnAcceptsLifecycleEvent,
  transitionApprovalStatus, transitionItemStatus, transitionRunAttemptStatus,
  transitionToolCallStatus, transitionTurnStatus,
  type ApprovalStatus, type ItemKind, type ItemStatus, type LifecycleEvent,
  type RunAttemptStatus, type ToolCallStatus, type TurnBlockingState, type TurnStatus,
} from "@repo/platform-protocol/lifecycle";
import type { RuntimeLifecycleCoordinatorOptions } from "./RuntimeLifecycleCoordinator.js";

export interface RestoredLifecycleState {
  status: TurnStatus;
  blockingState: TurnBlockingState;
  runAttemptStatus: RunAttemptStatus;
  itemStatuses: Record<string, ItemStatus>;
  itemKinds: Record<string, ItemKind>;
  toolCallStatuses: Record<string, ToolCallStatus>;
  toolCallNames: Record<string, string>;
  toolCallBatches: Record<string, ToolCallBatchId>;
  toolCallItems: Record<string, ItemId>;
  approvalStatuses: Record<string, ApprovalStatus>;
  approvalItems: Record<string, ItemId>;
  approvalParents: Record<string, ItemId>;
  accepted: boolean;
  sequence: number;
}

/** One canonical restoration reducer; callers retain their recovery policy. */
export function restoreApprovalWaitLifecycle(
  options: RuntimeLifecycleCoordinatorOptions,
  events: readonly LifecycleEvent[],
): RestoredLifecycleState {
  const state: RestoredLifecycleState = {
    status: "queued", blockingState: { kind: "none" }, runAttemptStatus: "queued",
    itemStatuses: {}, itemKinds: {}, toolCallStatuses: {}, toolCallNames: {},
    toolCallBatches: {}, toolCallItems: {}, approvalStatuses: {}, approvalItems: {},
    approvalParents: {}, accepted: false, sequence: 0,
  };

    let previousStatus: TurnStatus = "queued";
    let queued = false;
    let started = false;
    let lastEvent: LifecycleEvent | undefined;

    for (const event of events) {
      assertNextLifecycleSequence(
        { lastSequence: state.sequence },
        event.sequence,
      );
      if (
        event.threadId !== options.threadId ||
        event.turnId !== options.turnId ||
        event.runAttemptId !== options.runAttemptId
      ) {
        throw new LifecycleTransitionError(
          "turn",
          options.turnId,
          event.turnId,
          "lifecycle identity changed during approval-wait restoration",
        );
      }
      assertTurnAcceptsLifecycleEvent(previousStatus, event.type);
      if (
        event.type !== "turn.queued" &&
        event.type !== "turn.started" &&
        event.type !== "run_attempt.started" &&
        (!started || state.runAttemptStatus !== "running")
      ) {
        throw new LifecycleTransitionError(
          "turn",
          previousStatus,
          event.type,
          "lifecycle work requires a running run attempt",
        );
      }

      if (event.type === "turn.queued") {
        if (queued || started || event.sequence !== 1) {
          throw new LifecycleTransitionError(
            "turn",
            String(event.sequence),
            "turn.queued",
            "turn acceptance must begin the canonical lifecycle",
          );
        }
        queued = true;
      } else if (event.type === "turn.started") {
        if (!queued || started) {
          throw new LifecycleTransitionError(
            "turn",
            previousStatus,
            "turn.started",
            "turn must be accepted exactly once before it starts",
          );
        }
        const eventRevision = event.payload.revisionOfTurnId;
        if (
          (eventRevision !== undefined && typeof eventRevision !== "string") ||
          eventRevision !== options.revisionOfTurnId
        ) {
          throw new LifecycleTransitionError(
            "turn",
            typeof eventRevision === "string"
              ? eventRevision
              : "missing_revision",
            options.revisionOfTurnId ?? "no_revision",
            "turn revision identity changed during lifecycle restoration",
          );
        }
        if (
          event.payload.continuationOfTurnId !== options.continuationOfTurnId ||
          event.payload.originalPromptId !== options.originalPromptId
        ) {
          throw new LifecycleTransitionError(
            "turn",
            event.payload.continuationOfTurnId ?? "no_continuation",
            options.continuationOfTurnId ?? "no_continuation",
            "turn continuation identity changed during lifecycle restoration",
          );
        }
        previousStatus = transitionTurnStatus(previousStatus, "in_progress");
        started = true;
        state.accepted = true;
      } else if (event.type === "turn.blocking_changed") {
        if (!started) {
          throw new LifecycleTransitionError(
            "turn",
            previousStatus,
            "turn.blocking_changed",
            "turn must be started before it can block",
          );
        }
        const blocking = TurnBlockingStateSchema.parse(
          event.payload.blockingState,
        );
        if (
          blocking.kind !== "none" &&
          blocking.kind !== "waiting_for_approval"
        ) {
          throw new LifecycleTransitionError(
            "turn",
            blocking.kind,
            "waiting_for_approval",
            "only approval-wait recovery is supported",
          );
        }
        if (blocking.kind === "waiting_for_approval") {
          if (
            state.approvalStatuses[blocking.approvalId] !== "pending" ||
            state.approvalItems[blocking.approvalId] !== blocking.itemId
          ) {
            throw new LifecycleTransitionError(
              "approval",
              "missing",
              "pending",
              "blocking approval does not match a pending approval request",
            );
          }
          previousStatus = transitionTurnStatus(
            previousStatus,
            "awaiting_approval",
          );
        } else if (previousStatus === "awaiting_approval") {
          previousStatus = transitionTurnStatus(previousStatus, "in_progress");
        }
        state.blockingState = blocking;
      } else if (event.type === "run_attempt.started") {
        if (!started) {
          throw new LifecycleTransitionError(
            "run_attempt",
            "turn_not_started",
            "running",
            "run attempt cannot start before its turn",
          );
        }
        state.runAttemptStatus = transitionRunAttemptStatus(
          state.runAttemptStatus,
          "running",
        );
      } else if (
        event.type === "run_attempt.succeeded" ||
        event.type === "run_attempt.failed" ||
        event.type === "run_attempt.interrupted"
      ) {
        const next =
          event.type === "run_attempt.succeeded"
            ? "succeeded"
            : event.type === "run_attempt.failed"
              ? "failed"
              : "interrupted";
        state.runAttemptStatus = transitionRunAttemptStatus(
          state.runAttemptStatus,
          next,
        );
      } else if (event.type === "item.started") {
        const kind = ItemKindSchema.parse(event.payload.kind);
        if (state.itemStatuses[event.itemId]) {
          throw new LifecycleTransitionError(
            "item",
            state.itemStatuses[event.itemId]!,
            "active",
            `item ${event.itemId} was started more than once`,
          );
        }
        state.itemStatuses[event.itemId] = transitionItemStatus(
          "not_started",
          "active",
        );
        state.itemKinds[event.itemId] = kind;
        if (kind === "approval_request") {
          const parentItemId = event.payload.parentItemId;
          if (parentItemId) {
            state.approvalParents[event.itemId] = parentItemId;
          }
        }
      } else if (
        event.type === "item.completed" ||
        event.type === "item.failed" ||
        event.type === "item.declined" ||
        event.type === "item.interrupted"
      ) {
        const status = event.type.slice("item.".length) as Exclude<
          ItemStatus,
          "not_started" | "active"
        >;
        const current = state.itemStatuses[event.itemId] ?? "not_started";
        state.itemStatuses[event.itemId] = transitionItemStatus(current, status);
      } else if (event.type === "tool_call.started") {
        if (
          state.toolCallStatuses[event.toolCallId] ||
          state.itemStatuses[event.itemId] !== "active" ||
          state.itemKinds[event.itemId] !== "tool_call"
        ) {
          throw new LifecycleTransitionError(
            "tool_call",
            state.toolCallStatuses[event.toolCallId] ?? "missing",
            "active",
            `tool call ${event.toolCallId} has no fresh active item`,
          );
        }
        state.toolCallStatuses[event.toolCallId] = transitionToolCallStatus(
          "not_started",
          "active",
        );
        state.toolCallItems[event.toolCallId] = event.itemId;
      } else if (
        event.type === "tool_call.input_delta" ||
        event.type === "tool_call.output_delta"
      ) {
        if (
          state.toolCallStatuses[event.toolCallId] !== "active" ||
          state.toolCallItems[event.toolCallId] !== event.itemId
        ) {
          throw new LifecycleTransitionError(
            "tool_call",
            state.toolCallStatuses[event.toolCallId] ?? "missing",
            "active",
            `tool call ${event.toolCallId} is not active on its owning item`,
          );
        }
      } else if (
        event.type === "tool_call.completed" ||
        event.type === "tool_call.failed" ||
        event.type === "tool_call.declined" ||
        event.type === "tool_call.interrupted"
      ) {
        if (state.toolCallItems[event.toolCallId] !== event.itemId) {
          throw new LifecycleTransitionError(
            "tool_call",
            "missing",
            event.type,
            `tool call ${event.toolCallId} has no matching owner item`,
          );
        }
        const status = event.type.slice("tool_call.".length) as Exclude<
          ToolCallStatus,
          "not_started" | "active"
        >;
        state.toolCallStatuses[event.toolCallId] = transitionToolCallStatus(
          state.toolCallStatuses[event.toolCallId] ?? "not_started",
          status,
        );
      } else if (event.type === "approval.requested") {
        if (
          state.itemStatuses[event.itemId] !== "active" ||
          state.approvalStatuses[event.approvalId]
        ) {
          throw new LifecycleTransitionError(
            "approval",
            state.approvalStatuses[event.approvalId] ?? "missing",
            "pending",
            `approval ${event.approvalId} has no fresh active request item`,
          );
        }
        state.approvalStatuses[event.approvalId] = "pending";
        state.approvalItems[event.approvalId] = event.itemId;
      } else if (event.type === "approval.decided") {
        const current = state.approvalStatuses[event.approvalId];
        if (!current || state.approvalItems[event.approvalId] !== event.itemId) {
          throw new LifecycleTransitionError(
            "approval",
            "missing",
            String(event.payload.status),
            `approval ${event.approvalId} has no matching request`,
          );
        }
        state.approvalStatuses[event.approvalId] = transitionApprovalStatus(
          current,
          event.payload.status,
        );
      } else if (
        event.type.startsWith("user_input.") ||
        event.type === "request.resolved" ||
        event.type === "context_compaction.requested" ||
        event.type === "context_compaction.started" ||
        event.type.startsWith("hook.invocation.")
      ) {
        throw new LifecycleTransitionError(
          "turn",
          event.type,
          "awaiting_approval",
          "history contains another pending runtime owner",
        );
      }

      if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"
      ) {
        throw new LifecycleTransitionError(
          "turn",
          event.type,
          "awaiting_approval",
          "terminal history cannot be restored for interruption",
        );
      }
      state.sequence = event.sequence;
      lastEvent = event;
    }

    const pendingApprovals = Object.entries(state.approvalStatuses).filter(
      ([, status]) => status === "pending",
    );
    const pendingApproval = pendingApprovals[0];
    const pendingApprovalId = pendingApproval?.[0];
    const pendingApprovalItemId = pendingApprovalId
      ? state.approvalItems[pendingApprovalId]
      : undefined;
    const approvalParent = pendingApprovalItemId
      ? state.approvalParents[pendingApprovalItemId]
      : undefined;
    const activeToolCalls = Object.entries(state.toolCallStatuses).filter(
      ([, status]) => status === "active",
    );
    const activeItems = Object.entries(state.itemStatuses)
      .filter(([, status]) => status === "active")
      .map(([itemId]) => itemId);
    if (
      !state.accepted ||
      !started ||
      state.runAttemptStatus !== "running" ||
      previousStatus !== "awaiting_approval" ||
      state.blockingState.kind !== "waiting_for_approval" ||
      pendingApprovals.length !== 1 ||
      !pendingApprovalId ||
      !pendingApprovalItemId ||
      state.blockingState.approvalId !== pendingApprovalId ||
      state.blockingState.itemId !== pendingApprovalItemId ||
      !approvalParent ||
      activeToolCalls.length !== 1 ||
      activeToolCalls.some(
        ([toolCallId]) => state.toolCallItems[toolCallId] !== approvalParent,
      ) ||
      activeItems.length !== activeToolCalls.length + 1 ||
      !activeItems.includes(approvalParent) ||
      state.itemKinds[approvalParent] !== "tool_call" ||
      state.itemKinds[pendingApprovalItemId] !== "approval_request" ||
      !activeItems.includes(pendingApprovalItemId) ||
      lastEvent?.type !== "turn.blocking_changed"
    ) {
      throw new LifecycleTransitionError(
        "turn",
        previousStatus,
        "awaiting_approval",
        "history does not prove an isolated pending approval gate",
      );
    }
    state.status = previousStatus;
  return state;
}
