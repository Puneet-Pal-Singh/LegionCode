import {
  ItemKindSchema,
  transitionApprovalStatus,
  transitionItemStatus,
  transitionToolCallStatus,
  transitionTurnStatus,
  validateTerminalSettlement,
  type ApprovalStatus,
  type ItemStatus,
  type LifecycleEvent,
  type ToolCallStatus,
} from "@repo/platform-protocol/lifecycle";
import {
  LIFECYCLE_PROJECTION_VERSION,
  LifecycleProjectionError,
  LifecycleProjectionSnapshotSchema,
  type LifecycleApprovalProjection,
  type LifecycleItemProjection,
  type LifecycleProjectionSnapshot,
  type LifecycleRequestProjection,
  type LifecycleToolCallProjection,
} from "./types.js";

interface MutableProjection {
  turnId: string;
  status: LifecycleProjectionSnapshot["status"];
  blockingState: LifecycleProjectionSnapshot["blockingState"];
  terminalOutcome: LifecycleProjectionSnapshot["terminalOutcome"];
  items: Map<string, LifecycleItemProjection>;
  toolCalls: Map<string, LifecycleToolCallProjection>;
  approvals: Map<string, LifecycleApprovalProjection>;
  requests: Map<string, LifecycleRequestProjection>;
  lastSequence: number;
}

export function projectLifecycleEvents(
  events: readonly LifecycleEvent[],
): LifecycleProjectionSnapshot | null {
  if (events.length === 0) return null;
  const state = createState(events[0]?.turnId ?? "");
  for (const event of events) applyLifecycleProjectionEvent(state, event);
  return snapshot(state);
}

export class LifecycleProjector {
  private readonly state: MutableProjection;

  constructor(turnId: string) {
    this.state = createState(turnId);
  }

  apply(event: LifecycleEvent): LifecycleProjectionSnapshot {
    applyLifecycleProjectionEvent(this.state, event);
    return snapshot(this.state);
  }
}

function applyLifecycleProjectionEvent(
  state: MutableProjection,
  event: LifecycleEvent,
): void {
  assertEnvelope(state, event);
  applyTurn(state, event);
  applyItem(state, event);
  applyToolCall(state, event);
  applyApproval(state, event);
  applyRequest(state, event);
  state.lastSequence = event.sequence;
}

function applyTurn(state: MutableProjection, event: LifecycleEvent): void {
  if (event.type === "turn.started") {
    state.status = transitionTurnStatus(state.status, "in_progress");
  } else if (event.type === "turn.blocking_changed") {
    const value = event.payload.blockingState;
    state.blockingState = LifecycleProjectionSnapshotSchema.shape.blockingState.parse(value);
  } else if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) {
    applyTerminal(state, event);
  }
}

function applyTerminal(state: MutableProjection, event: LifecycleEvent): void {
  if (
    event.type !== "turn.completed" &&
    event.type !== "turn.failed" &&
    event.type !== "turn.interrupted"
  ) return;
  const outcome = event.payload.outcome;
  const next = transitionTurnStatus(state.status, outcome.status);
  validateTerminalSettlement({
    turnStatus: next,
    terminalOutcome: outcome,
    blockingState: state.blockingState,
    itemStatuses: Object.fromEntries([...state.items].map(([id, item]) => [id, item.status])),
    approvalStatuses: Object.fromEntries(
      [...state.approvals].map(([id, approval]) => [id, approval.status]),
    ),
  });
  state.status = next;
  state.terminalOutcome = outcome;
}

function applyItem(state: MutableProjection, event: LifecycleEvent): void {
  if (!("itemId" in event) || !event.itemId) return;
  if (event.type === "item.started") {
    state.items.set(event.itemId, {
      itemId: event.itemId,
      kind: ItemKindSchema.parse(event.payload.kind),
      status: "active",
      text: "",
      lastSequence: event.sequence,
    });
    return;
  }
  const item = state.items.get(event.itemId);
  if (!item) return;
  const text = readItemDelta(event);
  const terminal = itemTerminalStatus(event.type);
  state.items.set(event.itemId, {
    ...item,
    status: terminal ? transitionItemStatus(item.status, terminal) : item.status,
    text: text === null ? item.text : item.text + text,
    lastSequence: event.sequence,
  });
}

function applyToolCall(state: MutableProjection, event: LifecycleEvent): void {
  if (!("toolCallId" in event) || !event.toolCallId || !("itemId" in event)) return;
  if (event.type === "tool_call.started") {
    state.toolCalls.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      itemId: event.itemId,
      status: "active",
      outputText: "",
      lastSequence: event.sequence,
    });
    return;
  }
  const tool = state.toolCalls.get(event.toolCallId);
  if (!tool) return;
  const terminal = toolTerminalStatus(event.type);
  const output = event.type === "tool_call.output_delta" ? readString(event.payload.output) : "";
  state.toolCalls.set(event.toolCallId, {
    ...tool,
    status: terminal ? transitionToolCallStatus(tool.status, terminal) : tool.status,
    outputText: tool.outputText + output,
    lastSequence: event.sequence,
  });
}

function applyApproval(state: MutableProjection, event: LifecycleEvent): void {
  if (!("approvalId" in event) || !event.approvalId || !("itemId" in event)) return;
  if (event.type === "approval.requested") {
    state.approvals.set(event.approvalId, {
      approvalId: event.approvalId,
      itemId: event.itemId,
      status: "pending",
      lastSequence: event.sequence,
    });
  } else if (event.type === "approval.decided") {
    const current = state.approvals.get(event.approvalId);
    if (!current) return;
    const status = event.payload.status as Exclude<ApprovalStatus, "pending">;
    state.approvals.set(event.approvalId, {
      ...current,
      status: transitionApprovalStatus(current.status, status),
      lastSequence: event.sequence,
    });
  }
}

function applyRequest(state: MutableProjection, event: LifecycleEvent): void {
  if (!("requestId" in event) || !event.requestId || !("itemId" in event)) return;
  if (event.type === "user_input.requested") {
    state.requests.set(event.requestId, {
      requestId: event.requestId,
      itemId: event.itemId,
      status: "pending",
      lastSequence: event.sequence,
    });
  } else if (event.type === "request.resolved") {
    const request = state.requests.get(event.requestId);
    if (request) state.requests.set(event.requestId, { ...request, status: "resolved", lastSequence: event.sequence });
  }
}

function assertEnvelope(state: MutableProjection, event: LifecycleEvent): void {
  if (event.turnId !== state.turnId) {
    throw new LifecycleProjectionError("identity_mismatch", "Event belongs to another turn");
  }
  if (event.sequence !== state.lastSequence + 1) {
    throw new LifecycleProjectionError("sequence_gap", "Projection sequence is not contiguous");
  }
  if (state.terminalOutcome) {
    throw new LifecycleProjectionError("corrupt_event", "Event appears after terminal outcome");
  }
}

function createState(turnId: string): MutableProjection {
  return {
    turnId,
    status: "queued",
    blockingState: { kind: "none" },
    terminalOutcome: null,
    items: new Map(),
    toolCalls: new Map(),
    approvals: new Map(),
    requests: new Map(),
    lastSequence: 0,
  };
}

function snapshot(state: MutableProjection): LifecycleProjectionSnapshot {
  return LifecycleProjectionSnapshotSchema.parse({
    turnId: state.turnId,
    status: state.status,
    blockingState: state.blockingState,
    terminalOutcome: state.terminalOutcome,
    items: [...state.items.values()],
    toolCalls: [...state.toolCalls.values()],
    approvals: [...state.approvals.values()],
    requests: [...state.requests.values()],
    lastSequence: state.lastSequence,
    projectionVersion: LIFECYCLE_PROJECTION_VERSION,
  });
}

function readItemDelta(event: LifecycleEvent): string | null {
  if (event.type === "assistant_message.delta") return readString(event.payload.delta);
  if (event.type === "reasoning.summary_delta") return readString(event.payload.delta);
  return null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function itemTerminalStatus(type: string): ItemStatus | null {
  const status = type.startsWith("item.") ? type.slice(5) : "";
  return ["completed", "failed", "declined", "interrupted"].includes(status)
    ? (status as ItemStatus)
    : null;
}

function toolTerminalStatus(type: string): ToolCallStatus | null {
  const status = type.startsWith("tool_call.") ? type.slice(10) : "";
  return ["completed", "failed", "declined", "interrupted"].includes(status)
    ? (status as ToolCallStatus)
    : null;
}
