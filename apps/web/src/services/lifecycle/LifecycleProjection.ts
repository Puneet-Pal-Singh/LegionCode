import type {
  ApprovalId,
  ItemId,
  ItemKind,
  LifecycleEvent,
  TurnDiffPayload,
  TurnId,
} from "../api/lifecycleClient";

export type LifecycleProjectionTerminalState =
  | "completed"
  | "failed"
  | "interrupted";

export type LifecycleProjectionItemStatus =
  | "active"
  | "completed"
  | "failed"
  | "declined"
  | "interrupted";

export interface LifecycleProjectionItem {
  readonly itemId: ItemId;
  readonly kind: ItemKind | "unknown";
  readonly status: LifecycleProjectionItemStatus;
  readonly text: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface LifecycleProjectionApproval {
  readonly approvalId: ApprovalId;
  readonly itemId: ItemId;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decision: string | null;
}

export interface LifecycleProjectionTerminal {
  readonly state: LifecycleProjectionTerminalState;
  readonly eventId: string;
  readonly content: string;
  readonly occurredAt: string;
}

export interface LifecycleProjection {
  readonly turnId: TurnId;
  readonly lastSequence: number;
  readonly items: readonly LifecycleProjectionItem[];
  readonly pendingApproval: LifecycleProjectionApproval | null;
  readonly terminal: LifecycleProjectionTerminal | null;
  readonly turnDiff: TurnDiffPayload | null;
  readonly activeThinking: boolean;
  readonly assistantText: string;
}

type ItemEvent = LifecycleEvent & {
  readonly itemId: ItemId;
  readonly payload: Record<string, unknown>;
};

type ApprovalEvent = ItemEvent & {
  readonly approvalId: ApprovalId;
};

type TerminalTurnEvent = LifecycleEvent & {
  readonly payload: { readonly outcome: Record<string, unknown> };
};

export function createLifecycleProjection(turnId: TurnId): LifecycleProjection {
  return {
    turnId,
    lastSequence: 0,
    items: [],
    pendingApproval: null,
    terminal: null,
    turnDiff: null,
    activeThinking: false,
    assistantText: "",
  };
}

export function applyLifecycleEvent(
  projection: LifecycleProjection,
  event: LifecycleEvent,
): LifecycleProjection {
  if (event.turnId !== projection.turnId) {
    return projection;
  }
  const next = applyKnownEvent(projection, event);
  return {
    ...next,
    lastSequence: Math.max(next.lastSequence, event.sequence),
    activeThinking: hasActiveThinking(next),
    assistantText: collectAssistantText(next.items),
  };
}

export function replayLifecycleProjection(
  turnId: TurnId,
  events: readonly LifecycleEvent[],
): LifecycleProjection {
  return events.reduce(applyLifecycleEvent, createLifecycleProjection(turnId));
}

function applyKnownEvent(
  projection: LifecycleProjection,
  event: LifecycleEvent,
): LifecycleProjection {
  switch (event.type) {
    case "item.started":
      return upsertItem(projection, createStartedItem(event));
    case "assistant_message.delta":
    case "reasoning.summary_delta":
    case "plan.updated":
      return appendItemText(projection, event.itemId, readTextPayload(event.payload));
    case "item.completed":
    case "item.failed":
    case "item.declined":
    case "item.interrupted":
      return settleItem(projection, event);
    case "approval.requested":
      return requestApproval(projection, event);
    case "approval.decided":
      return decideApproval(projection, event);
    case "request.resolved":
      return { ...projection, pendingApproval: null };
    case "turn.diff_updated":
      return { ...projection, turnDiff: readTurnDiff(event.payload) };
    case "turn.completed":
      return settleTurn(projection, "completed", event);
    case "turn.failed":
      return settleTurn(projection, "failed", event);
    case "turn.interrupted":
      return settleTurn(projection, "interrupted", event);
    default:
      return projection;
  }
}

function createStartedItem(event: ItemEvent): LifecycleProjectionItem {
  return {
    itemId: event.itemId,
    kind: readItemKind(event.payload),
    status: "active",
    text: readTextPayload(event.payload),
    startedAt: event.createdAt,
    completedAt: null,
  };
}

function upsertItem(
  projection: LifecycleProjection,
  item: LifecycleProjectionItem,
): LifecycleProjection {
  const existing = projection.items.some(
    (candidate) => candidate.itemId === item.itemId,
  );
  return {
    ...projection,
    items: existing
      ? projection.items.map((candidate) =>
          candidate.itemId === item.itemId ? item : candidate,
        )
      : [...projection.items, item],
  };
}

function appendItemText(
  projection: LifecycleProjection,
  itemId: ItemId,
  text: string,
): LifecycleProjection {
  if (!text) {
    return projection;
  }
  return updateItem(projection, itemId, (item) => ({
    ...item,
    text: item.text ? `${item.text}${text}` : text,
  }));
}

function settleItem(
  projection: LifecycleProjection,
  event: ItemEvent,
): LifecycleProjection {
  const status = event.type.replace("item.", "") as LifecycleProjectionItemStatus;
  const resultText =
    event.type === "item.completed"
      ? readTextPayload(event.payload.result)
      : "";
  return updateItem(projection, event.itemId, (item) => ({
    ...item,
    status,
    text: resultText || item.text,
    completedAt: event.createdAt,
  }));
}

function requestApproval(
  projection: LifecycleProjection,
  event: ApprovalEvent,
): LifecycleProjection {
  return {
    ...projection,
    pendingApproval: {
      approvalId: event.approvalId,
      itemId: event.itemId,
      requestedAt: event.createdAt,
      decidedAt: null,
      decision: null,
    },
  };
}

function decideApproval(
  projection: LifecycleProjection,
  event: ApprovalEvent,
): LifecycleProjection {
  const decision = readString(event.payload, "decision");
  const pendingApproval = projection.pendingApproval;
  if (!pendingApproval || pendingApproval.approvalId !== event.approvalId) {
    return projection;
  }
  return {
    ...projection,
    pendingApproval: {
      ...pendingApproval,
      decidedAt: event.createdAt,
      decision,
    },
  };
}

function settleTurn(
  projection: LifecycleProjection,
  state: LifecycleProjectionTerminalState,
  event: TerminalTurnEvent,
): LifecycleProjection {
  return {
    ...projection,
    items: projection.items.map(settleActiveItem),
    pendingApproval: null,
    terminal: {
      state,
      eventId: event.eventId,
      content: buildTerminalContent(state, event.payload.outcome),
      occurredAt: event.createdAt,
    },
  };
}

function updateItem(
  projection: LifecycleProjection,
  itemId: ItemId,
  update: (item: LifecycleProjectionItem) => LifecycleProjectionItem,
): LifecycleProjection {
  return {
    ...projection,
    items: projection.items.map((item) =>
      item.itemId === itemId ? update(item) : item,
    ),
  };
}

function settleActiveItem(
  item: LifecycleProjectionItem,
): LifecycleProjectionItem {
  if (item.status !== "active") {
    return item;
  }
  return { ...item, status: "completed", completedAt: item.completedAt };
}

function hasActiveThinking(projection: LifecycleProjection): boolean {
  if (projection.terminal) {
    return false;
  }
  return projection.items.some(
    (item) =>
      item.status === "active" &&
      (item.kind === "reasoning" || item.kind === "plan"),
  );
}

function collectAssistantText(
  items: readonly LifecycleProjectionItem[],
): string {
  return items
    .filter((item) => item.kind === "assistant_message")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function readItemKind(payload: Record<string, unknown>): ItemKind | "unknown" {
  const value = readString(payload, "kind");
  switch (value) {
    case "user_message":
    case "reasoning":
    case "plan":
    case "assistant_message":
    case "tool_call":
    case "command_execution":
    case "file_change":
    case "git_operation":
    case "approval_request":
    case "user_input_request":
    case "artifact":
    case "context_compaction":
    case "warning":
      return value;
    default:
      return "unknown";
  }
}

function readTurnDiff(payload: Record<string, unknown>): TurnDiffPayload | null {
  const candidate = payload.diff;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  return candidate as TurnDiffPayload;
}

function buildTerminalContent(
  state: LifecycleProjectionTerminalState,
  outcome: Record<string, unknown>,
): string {
  const summary = readString(outcome, "summary");
  if (summary) {
    return summary;
  }
  if (state === "completed") {
    return "Turn completed.";
  }
  const reason = readString(outcome, "reason");
  return reason ? `Turn ${state}: ${reason}` : `Turn ${state}.`;
}

function readTextPayload(payload: Record<string, unknown>): string {
  return (
    readString(payload, "text") ??
    readString(payload, "delta") ??
    readString(payload, "content") ??
    readString(payload, "summary") ??
    ""
  );
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}
