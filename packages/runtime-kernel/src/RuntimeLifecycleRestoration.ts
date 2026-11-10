import type {
  ItemId,
  JsonRecord,
  ProtocolError,
  ToolCallBatchId,
} from "@repo/platform-protocol";
import {
  LifecycleTransitionError,
  ItemKindSchema,
  TurnBlockingStateSchema,
  assertNextLifecycleSequence,
  assertTurnAcceptsLifecycleEvent,
  transitionApprovalStatus,
  transitionItemStatus,
  transitionRunAttemptStatus,
  transitionToolCallStatus,
  transitionTurnStatus,
  type ApprovalStatus,
  type ContextCompactionPayload,
  type ItemKind,
  type ItemStatus,
  type LifecycleEvent,
  type RunAttemptStatus,
  type ToolCallStatus,
  type TurnBlockingState,
  type TurnStatus,
} from "@repo/platform-protocol/lifecycle";
import type { RuntimeLifecycleCoordinatorOptions } from "./RuntimeLifecycleCoordinator.js";

export interface RestoredItemSettlement {
  status: Exclude<ItemStatus, "not_started" | "active">;
  payload: JsonRecord;
}

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
  pendingItemSettlements: Record<string, RestoredItemSettlement>;
  activeCompactions: Record<string, ContextCompactionPayload>;
  accepted: boolean;
  sequence: number;
}

/** One canonical restoration reducer; callers retain their recovery policy. */
export function restoreRuntimeLifecycle(
  options: RuntimeLifecycleCoordinatorOptions,
  events: readonly LifecycleEvent[],
  policy: "approval_wait" | "process_loss",
): RestoredLifecycleState {
  const state: RestoredLifecycleState = {
    status: "queued",
    blockingState: { kind: "none" },
    runAttemptStatus: "queued",
    itemStatuses: {},
    itemKinds: {},
    toolCallStatuses: {},
    toolCallNames: {},
    toolCallBatches: {},
    toolCallItems: {},
    approvalStatuses: {},
    approvalItems: {},
    approvalParents: {},
    pendingItemSettlements: {},
    activeCompactions: {},
    accepted: false,
    sequence: 0,
  };

  let previousStatus: TurnStatus = "queued";
  let queued = false;
  let started = false;
  let lastEvent: LifecycleEvent | undefined;

  for (const event of events) {
    if (policy === "process_loss") {
      if (
        event.producer.kind !== "runtime_kernel" ||
        event.producer.id !== options.producerId
      ) {
        throw invalid(
          event,
          "Lifecycle history belongs to another runtime producer",
        );
      }
      if (
        event.type === "run_attempt.started" &&
        event.payload.executionCapability !== options.executionCapability
      ) {
        throw invalid(
          event,
          "Run attempt changed its admitted execution capability",
        );
      }
      assertNativeProcessLossEvent(event, state);
    }
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
      const pending = state.pendingItemSettlements[event.itemId];
      if (
        policy === "process_loss" &&
        pending &&
        (pending.status !== status ||
          !equalJson(pending.payload, event.payload))
      ) {
        throw invalid(
          event,
          "Item settlement differs from its durable canonical result",
        );
      }
      state.itemStatuses[event.itemId] = transitionItemStatus(current, status);
      delete state.pendingItemSettlements[event.itemId];
      delete state.activeCompactions[event.itemId];
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
      const toolName = event.payload.toolName;
      if (typeof toolName === "string")
        state.toolCallNames[event.toolCallId] = toolName;
      else if (policy === "process_loss")
        throw invalid(event, "Native tool history has no canonical tool name");
      if (event.payload.callBatchId)
        state.toolCallBatches[event.toolCallId] = event.payload.callBatchId;
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
      if (policy === "process_loss") {
        if (
          (event.payload.toolName !== undefined &&
            event.payload.toolName !== state.toolCallNames[event.toolCallId]) ||
          (event.payload.callBatchId !== undefined &&
            event.payload.callBatchId !==
              state.toolCallBatches[event.toolCallId])
        ) {
          throw invalid(
            event,
            "Tool settlement changed its canonical name or batch",
          );
        }
        const payload: JsonRecord =
          event.type === "tool_call.completed"
            ? { result: event.payload.result }
            : event.type === "tool_call.failed"
              ? { failure: event.payload.failure }
              : { reason: event.payload.reason };
        state.pendingItemSettlements[event.itemId] = { status, payload };
      }
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
      if (policy === "process_loss")
        state.pendingItemSettlements[event.itemId] =
          event.payload.status === "approved"
            ? { status: "completed", payload: { result: {} } }
            : {
                status: "declined",
                payload: { reason: `Approval ${event.payload.status}` },
              };
    } else if (
      policy === "process_loss" &&
      (event.type === "context_compaction.requested" ||
        event.type === "context_compaction.started" ||
        event.type === "context_compaction.completed" ||
        event.type === "context_compaction.failed")
    ) {
      if (
        state.itemKinds[event.itemId] !== "context_compaction" ||
        state.itemStatuses[event.itemId] !== "active" ||
        event.payload.itemId !== event.itemId
      ) {
        throw invalid(
          event,
          "Compaction event has no matching active canonical item",
        );
      }
      const expectedPhase =
        event.type === "context_compaction.requested"
          ? "requested"
          : event.type === "context_compaction.started"
            ? "compacting"
            : event.type === "context_compaction.completed"
              ? "compacted"
              : "failed";
      if (event.payload.phase !== expectedPhase)
        throw invalid(event, "Compaction event phase does not match its type");
      const previous = state.activeCompactions[event.itemId];
      if (
        (event.type === "context_compaction.requested" && previous) ||
        (event.type !== "context_compaction.requested" &&
          (!previous ||
            previous.compactionId !== event.payload.compactionId ||
            previous.mode !== event.payload.mode)) ||
        (event.type === "context_compaction.started" &&
          previous?.phase !== "requested") ||
        ((event.type === "context_compaction.completed" ||
          event.type === "context_compaction.failed") &&
          previous?.phase !== "compacting")
      ) {
        throw invalid(event, "Compaction history changed identity or phase");
      }
      state.activeCompactions[event.itemId] = event.payload;
      if (event.type === "context_compaction.completed") {
        state.pendingItemSettlements[event.itemId] = {
          status: "completed",
          payload: {
            result: {
              preservedContextReference:
                event.payload.preservedContextReference,
            },
          },
        };
      } else if (event.type === "context_compaction.failed") {
        state.pendingItemSettlements[event.itemId] = {
          status: "failed",
          payload: { failure: compactionFailure(event.payload) },
        };
      }
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

  if (policy === "process_loss") {
    if (!state.accepted || !started || state.runAttemptStatus !== "running") {
      throw new LifecycleTransitionError(
        "turn",
        previousStatus,
        "failed",
        "Process-loss history requires a canonically started native attempt",
      );
    }
    state.status = previousStatus;
    return state;
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

const NATIVE_PROCESS_LOSS_EVENT_TYPES = new Set([
  "turn.queued",
  "turn.started",
  "run_attempt.started",
  "turn.blocking_changed",
  "item.started",
  "item.updated",
  "item.completed",
  "item.failed",
  "item.declined",
  "item.interrupted",
  "assistant_message.delta",
  "reasoning.summary_delta",
  "plan.updated",
  "tool_call.started",
  "tool_call.input_delta",
  "tool_call.output_delta",
  "tool_call.completed",
  "tool_call.failed",
  "tool_call.declined",
  "tool_call.interrupted",
  "approval.requested",
  "approval.decided",
  "context_budget.updated",
  "usage.updated",
  "context_compaction.requested",
  "context_compaction.started",
  "context_compaction.completed",
  "context_compaction.failed",
]);

/** Native process loss never takes ownership of delegated or mutating work. */
function assertNativeProcessLossEvent(
  event: LifecycleEvent,
  state: RestoredLifecycleState,
): void {
  if (!NATIVE_PROCESS_LOSS_EVENT_TYPES.has(event.type))
    throw invalid(event, "History contains an unsupported runtime owner");
  if (
    event.type === "item.started" &&
    ![
      "commentary",
      "reasoning",
      "plan",
      "assistant_message",
      "tool_call",
      "approval_request",
      "context_compaction",
      "warning",
    ].includes(String(event.payload.kind))
  ) {
    throw invalid(event, "History contains an unsupported native item owner");
  }
  if (
    event.type === "item.updated" ||
    event.type === "assistant_message.delta" ||
    event.type === "reasoning.summary_delta" ||
    event.type === "plan.updated"
  ) {
    if (
      event.payload.kind !== undefined &&
      event.payload.kind !== state.itemKinds[event.itemId]
    )
      throw invalid(event, "Item update changed its canonical kind");
    if (state.itemStatuses[event.itemId] !== "active")
      throw invalid(event, "Item update has no active canonical item");
    if (
      (event.type === "assistant_message.delta" &&
        !["assistant_message", "commentary"].includes(
          String(state.itemKinds[event.itemId]),
        )) ||
      (event.type === "reasoning.summary_delta" &&
        state.itemKinds[event.itemId] !== "reasoning") ||
      (event.type === "plan.updated" &&
        state.itemKinds[event.itemId] !== "plan")
    ) {
      throw invalid(event, "Item update changed its canonical kind");
    }
  }
  if (
    event.type === "tool_call.started" &&
    Object.values(state.toolCallItems).includes(event.itemId)
  ) {
    throw invalid(event, "A canonical item cannot own multiple tool calls");
  }
  if (event.type === "approval.requested") {
    if (Object.values(state.approvalItems).includes(event.itemId))
      throw invalid(event, "A canonical item cannot own multiple approvals");
    const parent = state.approvalParents[event.itemId];
    if (
      state.itemKinds[event.itemId] !== "approval_request" ||
      !parent ||
      state.itemKinds[parent] !== "tool_call" ||
      state.itemStatuses[parent] !== "active"
    ) {
      throw invalid(event, "Approval has no active native tool owner");
    }
  }
  if (
    (event.type === "item.completed" ||
      event.type === "item.failed" ||
      event.type === "item.declined" ||
      event.type === "item.interrupted") &&
    state.itemStatuses[event.itemId] !== "active"
  ) {
    throw invalid(event, "Item settlement has no active canonical item");
  }
  if (
    event.type === "item.completed" ||
    event.type === "item.failed" ||
    event.type === "item.declined" ||
    event.type === "item.interrupted"
  ) {
    if (
      Object.entries(state.toolCallItems).some(
        ([id, item]) =>
          item === event.itemId && state.toolCallStatuses[id] === "active",
      ) ||
      Object.entries(state.approvalItems).some(
        ([id, item]) =>
          item === event.itemId && state.approvalStatuses[id] === "pending",
      ) ||
      (state.activeCompactions[event.itemId] &&
        !state.pendingItemSettlements[event.itemId])
    ) {
      throw invalid(event, "Item settled before its canonical work receipt");
    }
  }
}

function invalid(
  event: LifecycleEvent,
  message: string,
): LifecycleTransitionError {
  return new LifecycleTransitionError("turn", event.type, "failed", message);
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]))
    );
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        equalJson(a[key], b[key]),
    )
  );
}

export function compactionFailure(
  payload: ContextCompactionPayload,
): ProtocolError {
  return {
    code: "internal_error",
    message: payload.error?.trim() ? payload.error : "Context compaction failed",
    retryable: false,
    correlationId: null,
    details: { phase: "context_compaction" },
  };
}
