import {
  ContextBudgetSnapshotSchema,
  TurnDiffPayloadSchema,
  UsageCostSnapshotSchema,
} from "@repo/platform-protocol";
import type {
  ApprovalId,
  ContextBudgetSnapshot,
  ItemId,
  LifecycleEvent,
  TurnDiffPayload,
  TurnId,
  UsageCostSnapshot,
} from "@repo/platform-protocol";

export type WorkflowTerminalState = "completed" | "failed" | "interrupted";

export type WorkflowPhase =
  | "starting"
  | "working"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "interrupted";

export type WorkflowItemStatus =
  | "active"
  | "completed"
  | "failed"
  | "declined"
  | "interrupted";

export type WorkflowItemKind =
  | "reasoning"
  | "commentary"
  | "plan"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "command_execution"
  | "file_change"
  | "approval_request"
  | "context_compaction"
  | "warning"
  | "unknown";

export interface WorkflowItem {
  readonly itemId: ItemId;
  readonly sequence: number;
  readonly kind: WorkflowItemKind;
  readonly status: WorkflowItemStatus;
  readonly text: string;
  readonly detail: string | null;
  readonly toolFamily: string | null;
  readonly safeSummary: string | null;
  readonly inputSummary: string | null;
  readonly outputSummary: string | null;
  readonly toolName: string | null;
  readonly filePath: string | null;
  readonly command: string | null;
  readonly outputContent: string | null;
  readonly diffPreview: string | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly planSteps: readonly PlanWorkflowStep[];
  readonly compactionPhase: "compacting" | "compacted" | "failed" | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface PlanWorkflowStep {
  readonly stepId: string;
  readonly title: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface WorkflowApproval {
  readonly approvalId: ApprovalId;
  readonly itemId: ItemId;
  readonly question: string;
  readonly options: readonly string[];
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decision: string | null;
}

export interface WorkflowTerminal {
  readonly state: WorkflowTerminalState;
  readonly eventId: string;
  readonly content: string;
  readonly errorCode?: string | null;
  readonly occurredAt: string;
}

export interface TurnWorkflowProjection {
  readonly turnId: TurnId;
  readonly lastSequence: number;
  readonly items: readonly WorkflowItem[];
  readonly pendingApproval: WorkflowApproval | null;
  readonly terminal: WorkflowTerminal | null;
  readonly turnDiff: TurnDiffPayload | null;
  readonly activeThinking: boolean;
  readonly assistantText: string;
  readonly phase: WorkflowPhase;
  readonly startedAt: string | null;
  readonly settledAt: string | null;
  readonly contextBudget: ContextBudgetSnapshot | null;
  readonly usage: UsageCostSnapshot | null;
}

export function createTurnWorkflowProjection(
  turnId: TurnId,
): TurnWorkflowProjection {
  return {
    turnId,
    lastSequence: 0,
    items: [],
    pendingApproval: null,
    terminal: null,
    turnDiff: null,
    activeThinking: false,
    assistantText: "",
    phase: "starting",
    startedAt: null,
    settledAt: null,
    contextBudget: null,
    usage: null,
  };
}

export function applyLifecycleEvent(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
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

export function replayTurnWorkflowProjection(
  turnId: TurnId,
  events: readonly LifecycleEvent[],
): TurnWorkflowProjection {
  return events.reduce(
    applyLifecycleEvent,
    createTurnWorkflowProjection(turnId),
  );
}

function applyKnownEvent(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const type = event.type;
  switch (type) {
    case "turn.started":
      return {
        ...projection,
        phase: "starting",
        startedAt: earlierTimestamp(projection.startedAt, event.createdAt),
      };
    case "run_attempt.started":
      return {
        ...projection,
        phase: "working",
        startedAt: earlierTimestamp(projection.startedAt, event.createdAt),
      };
    case "item.started":
      return {
        ...upsertItem(projection, createStartedItem(event)),
        phase: "working",
      };
    case "assistant_message.delta":
      return {
        ...appendItemText(
          projection,
          requireItemId(event),
          readTextPayload(readPayload(event)),
        ),
        phase: "working",
      };
    case "reasoning.summary_delta":
      return {
        ...appendReasoningText(projection, event),
        phase: "working",
      };
    case "plan.updated":
      return { ...updatePlanItem(projection, event), phase: "working" };
    case "item.updated":
      return { ...updateItemFromPayload(projection, event), phase: "working" };
    case "item.completed":
    case "item.failed":
    case "item.declined":
    case "item.interrupted":
      return { ...settleItem(projection, event, type), phase: "working" };
    case "tool_call.started":
    case "tool_call.input_delta":
    case "tool_call.output_delta":
    case "tool_call.completed":
    case "tool_call.failed":
    case "tool_call.declined":
    case "tool_call.interrupted":
      return {
        ...handleToolCallEvent(projection, event, type),
        phase: "working",
      };
    case "approval.requested":
      return {
        ...requestApproval(projection, event),
        phase: "waiting_for_approval",
      };
    case "approval.decided":
      return { ...decideApproval(projection, event), phase: "working" };
    case "request.resolved":
      return { ...projection, pendingApproval: null, phase: "working" };
    case "turn.diff_updated":
      return {
        ...projection,
        turnDiff: readTurnDiff(readPayload(event)),
        phase: "working",
      };
    case "context_budget.updated":
      return {
        ...projection,
        contextBudget: readContextBudget(readPayload(event)),
      };
    case "usage.updated":
      return {
        ...projection,
        usage: readUsage(readPayload(event)),
      };
    case "context_compaction.requested":
    case "context_compaction.started":
    case "context_compaction.completed":
    case "context_compaction.failed":
      return {
        ...upsertCompactionItem(projection, event),
        phase:
          event.type === "context_compaction.failed" ? "failed" : "working",
      };
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

function readItemId(event: LifecycleEvent): ItemId | null {
  return "itemId" in event ? (event.itemId ?? null) : null;
}

function readPayload(event: LifecycleEvent): Record<string, unknown> {
  return event.payload;
}

function readItemKind(payload: Record<string, unknown>): WorkflowItemKind {
  const value = readString(payload, "kind");
  switch (value) {
    case "reasoning":
    case "commentary":
    case "assistant_message":
    case "plan":
    case "tool_call":
    case "command_execution":
    case "file_change":
    case "approval_request":
    case "context_compaction":
    case "warning":
      return value;
    case "user_message":
      return "user_message";
    default:
      return "unknown";
  }
}

function createStartedItem(event: LifecycleEvent): WorkflowItem {
  const payload = readPayload(event);
  return {
    itemId: requireItemId(event),
    sequence: event.sequence,
    kind: readItemKind(payload),
    status: "active",
    text: readTextPayload(payload),
    detail: readDisplayDetail(payload),
    toolFamily: readToolFamily(payload),
    safeSummary:
      readString(payload, "safeSummary") ?? readDisplayTitle(payload),
    inputSummary:
      readString(payload, "inputSummary") ?? readDisplayInput(payload),
    outputSummary:
      readString(payload, "outputSummary") ?? readDisplayOutput(payload),
    ...readToolDetails(payload),
    planSteps: readPlanSteps(payload),
    compactionPhase: readCompactionPhase(payload),
    startedAt: event.createdAt,
    completedAt: null,
  };
}

function upsertItem(
  projection: TurnWorkflowProjection,
  item: WorkflowItem,
): TurnWorkflowProjection {
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
  projection: TurnWorkflowProjection,
  itemId: ItemId,
  text: string,
): TurnWorkflowProjection {
  if (!text) return projection;
  return updateItem(projection, itemId, (item) => ({
    ...item,
    text: item.text ? `${item.text}${text}` : text,
  }));
}

function appendReasoningText(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const payload = readPayload(event);
  return payload.displaySafe === true
    ? appendItemText(projection, requireItemId(event), readTextPayload(payload))
    : projection;
}

function updatePlanItem(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const payload = readPayload(event);
  return updateItem(projection, requireItemId(event), (item) => ({
    ...item,
    detail: readString(payload, "explanation") ?? item.detail,
    planSteps: readPlanSteps(payload),
  }));
}

function updateItemFromPayload(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const payload = readPayload(event);
  return updateItem(projection, requireItemId(event), (item) => ({
    ...item,
    text: readTextPayload(payload) || item.text,
    detail: readDisplayDetail(payload) ?? item.detail,
    inputSummary: readString(payload, "inputSummary") ?? item.inputSummary,
    outputSummary: readString(payload, "outputSummary") ?? item.outputSummary,
    ...mergeToolDetails(item, readToolDetails(payload)),
    compactionPhase: readCompactionPhase(payload) ?? item.compactionPhase,
    planSteps: readPlanSteps(payload).length
      ? readPlanSteps(payload)
      : item.planSteps,
  }));
}

function settleItem(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
  eventType: string,
): TurnWorkflowProjection {
  const status = eventType.replace("item.", "") as WorkflowItemStatus;
  const payload = readPayload(event);
  const resultText =
    eventType === "item.completed" ? readTextPayload(payload) : "";
  const itemId = readItemId(event);
  if (!itemId) return projection;
  return updateItem(projection, itemId, (item) => ({
    ...item,
    status,
    text: resultText || item.text,
    completedAt: event.createdAt,
  }));
}

function handleToolCallEvent(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
  eventType: string,
): TurnWorkflowProjection {
  const payload = readPayload(event);
  const itemId = readItemId(event);
  if (!itemId) return projection;
  if (eventType === "tool_call.started") {
    return {
      ...upsertItem(projection, {
        itemId,
        sequence: event.sequence,
        kind: "tool_call",
        status: "active",
        text: readTextPayload(payload),
        detail: readDisplayDetail(payload),
        toolFamily: readToolFamily(payload),
        safeSummary: readDisplayTitle(payload),
        inputSummary: readDisplayInput(payload),
        outputSummary: readDisplayOutput(payload),
        ...readToolDetails(payload),
        planSteps: [],
        compactionPhase: null,
        startedAt: event.createdAt,
        completedAt: null,
      }),
      phase: "working",
    };
  }
  if (eventType === "tool_call.input_delta") {
    const details = readToolDetails(payload);
    return updateItem(projection, itemId, (item) => ({
      ...item,
      inputSummary: appendBounded(item.inputSummary, readTextPayload(payload)),
      ...mergeToolDetails(item, details),
    }));
  }
  if (eventType === "tool_call.output_delta") {
    return updateItem(projection, itemId, (item) => ({
      ...item,
      outputSummary: appendBounded(
        item.outputSummary,
        readTextPayload(payload),
      ),
    }));
  }
  const statusMap: Record<string, WorkflowItemStatus> = {
    "tool_call.completed": "completed",
    "tool_call.failed": "failed",
    "tool_call.declined": "declined",
    "tool_call.interrupted": "interrupted",
  };
  const status = statusMap[eventType] ?? "completed";
  const resultText =
    eventType === "tool_call.completed" ? readTextPayload(payload) : "";
  const details = readToolDetails(payload);
  return updateItem(projection, itemId, (item) => ({
    ...item,
    status,
    text: resultText || item.text,
    ...mergeToolDetails(item, details),
    completedAt: event.createdAt,
  }));
}

function requestApproval(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const payload = readPayload(event);
  const approvalId = requireApprovalId(event);
  return {
    ...projection,
    pendingApproval: {
      approvalId,
      itemId: requireItemId(event),
      question: readString(payload, "question") ?? "Approval requested.",
      options: readStringArray(payload, "options"),
      requestedAt: event.createdAt,
      decidedAt: null,
      decision: null,
    },
  };
}

function decideApproval(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const payload = readPayload(event);
  const approvalId = requireApprovalId(event);
  const decision = readString(payload, "decision");
  const pendingApproval = projection.pendingApproval;
  if (!pendingApproval || pendingApproval.approvalId !== approvalId) {
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
  projection: TurnWorkflowProjection,
  state: WorkflowTerminalState,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const payload = readPayload(event);
  const outcome =
    (payload.outcome as Record<string, unknown> | undefined) ?? {};
  return {
    ...projection,
    pendingApproval: null,
    terminal: {
      state,
      eventId: event.eventId,
      content: readString(outcome, "summary") ?? state,
      errorCode: readString(outcome, "code"),
      occurredAt: event.createdAt,
    },
    phase: state,
    settledAt: event.createdAt,
  };
}

function hasActiveThinking(projection: TurnWorkflowProjection): boolean {
  if (projection.terminal) return false;
  return projection.items.some(
    (item) =>
      item.status === "active" &&
      (item.kind === "reasoning" || item.kind === "plan"),
  );
}

function collectAssistantText(items: readonly WorkflowItem[]): string {
  return items
    .filter((item) => item.kind === "assistant_message")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function readTurnDiff(
  payload: Record<string, unknown>,
): TurnDiffPayload | null {
  const candidate = payload.diff ?? payload;
  const parsed = TurnDiffPayloadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function readContextBudget(
  payload: Record<string, unknown>,
): ContextBudgetSnapshot | null {
  const parsed = ContextBudgetSnapshotSchema.safeParse(payload.snapshot);
  return parsed.success ? parsed.data : null;
}

function readUsage(payload: Record<string, unknown>): UsageCostSnapshot | null {
  const parsed = UsageCostSnapshotSchema.safeParse(payload.usage);
  return parsed.success ? parsed.data : null;
}

function readTextPayload(payload: Record<string, unknown>): string {
  return (
    readString(payload, "delta") ??
    readString(payload, "text") ??
    readString(payload, "content") ??
    readString(payload, "summary") ??
    ""
  );
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function readToolFamily(payload: Record<string, unknown>): string | null {
  const display = readRecord(payload.display);
  return (
    readBoundedString(payload.toolFamily, 80) ??
    readBoundedString(display?.family, 80)
  );
}

function readDisplayInput(payload: Record<string, unknown>): string | null {
  const display = readRecord(payload.display);
  return (
    readBoundedString(payload.inputSummary, 280) ??
    readBoundedString(display?.inputSummary, 280)
  );
}

function readDisplayTitle(payload: Record<string, unknown>): string | null {
  const display = readRecord(payload.display);
  return readBoundedString(display?.title, 160);
}

function readDisplayOutput(payload: Record<string, unknown>): string | null {
  const display = readRecord(payload.display);
  return (
    readBoundedString(payload.outputSummary, 280) ??
    readBoundedString(display?.outputSummary, 280)
  );
}

function readCompactionPhase(
  payload: Record<string, unknown>,
): "compacting" | "compacted" | "failed" | null {
  const value = payload.compactionPhase ?? payload.phase;
  return value === "compacting" || value === "compacted" || value === "failed"
    ? value
    : null;
}

function upsertCompactionItem(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const payload = readPayload(event);
  const itemId = requireItemId(event);
  const phase = readCompactionPhase(payload);
  const existing = projection.items.find((item) => item.itemId === itemId);
  return upsertItem(projection, {
    itemId,
    sequence: existing?.sequence ?? event.sequence,
    kind: "context_compaction",
    status:
      event.type === "context_compaction.completed"
        ? "completed"
        : event.type === "context_compaction.failed"
          ? "failed"
          : "active",
    text:
      event.type === "context_compaction.failed"
        ? (readString(payload, "error") ?? "Context compaction failed")
        : phase === "compacted"
          ? "Context compacted"
          : "Context compacting",
    detail: null,
    toolFamily: null,
    safeSummary: null,
    inputSummary: null,
    outputSummary: null,
    toolName: null,
    filePath: null,
    command: null,
    outputContent: null,
    diffPreview: null,
    additions: null,
    deletions: null,
    planSteps: [],
    compactionPhase: phase,
    startedAt: existing?.startedAt ?? event.createdAt,
    completedAt:
      event.type === "context_compaction.completed" ||
      event.type === "context_compaction.failed"
        ? event.createdAt
        : null,
  });
}

type WorkflowToolDetails = Pick<
  WorkflowItem,
  | "toolName"
  | "filePath"
  | "command"
  | "outputContent"
  | "diffPreview"
  | "additions"
  | "deletions"
>;

function readToolDetails(
  payload: Record<string, unknown>,
): WorkflowToolDetails {
  const display = readRecord(payload.display);
  const input = readRecord(payload.input);
  const result = readRecord(payload.result);
  const metadata = readRecord(result?.metadata);
  const activity = readRecord(metadata?.activity) ?? metadata;
  return {
    toolName: readBoundedString(display?.namespace, 120),
    filePath:
      readBoundedString(input?.path, 500) ??
      readBoundedString(activity?.filePath, 500),
    command: readBoundedString(input?.command, 4_000),
    outputContent: readBoundedString(result?.content, 16_000),
    diffPreview: readBoundedString(activity?.diffPreview, 16_000),
    additions: readFiniteNumber(activity?.additions),
    deletions: readFiniteNumber(activity?.deletions),
  };
}

function mergeToolDetails(
  current: WorkflowToolDetails,
  next: WorkflowToolDetails,
): WorkflowToolDetails {
  return {
    toolName: next.toolName ?? current.toolName,
    filePath: next.filePath ?? current.filePath,
    command: next.command ?? current.command,
    outputContent: next.outputContent ?? current.outputContent,
    diffPreview: next.diffPreview ?? current.diffPreview,
    additions: next.additions ?? current.additions,
    deletions: next.deletions ?? current.deletions,
  };
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPlanSteps(
  payload: Record<string, unknown>,
): readonly PlanWorkflowStep[] {
  const steps = payload.steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => {
    const record = readRecord(step);
    const stepId = record ? readString(record, "stepId") : null;
    const title = record ? readString(record, "title") : null;
    const status = record?.status;
    if (
      !stepId ||
      !title ||
      !["pending", "in_progress", "completed"].includes(String(status))
    ) {
      return [];
    }
    return [{ stepId, title, status: status as PlanWorkflowStep["status"] }];
  });
}

function appendBounded(current: string | null, next: string): string | null {
  if (!next) return current;
  return `${current ?? ""}${next}`.slice(0, 4_000);
}

function readDisplayDetail(payload: Record<string, unknown>): string | null {
  const display = readRecord(payload.display);
  return (
    readBoundedString(payload.detail, 280) ??
    readBoundedString(display?.inputSummary, 280) ??
    readBoundedString(display?.outputSummary, 280)
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireItemId(event: LifecycleEvent): ItemId {
  const itemId = readItemId(event);
  if (!itemId) {
    throw new Error(`Lifecycle event ${event.type} is missing itemId.`);
  }
  return itemId;
}

function requireApprovalId(event: LifecycleEvent): ApprovalId {
  if ("approvalId" in event) return event.approvalId;
  throw new Error(`Lifecycle event ${event.type} is missing approvalId.`);
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readStringArray(
  payload: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (entry && typeof entry === "object" && "label" in entry) {
        const label = (entry as { readonly label?: unknown }).label;
        return typeof label === "string" ? label.trim() : "";
      }
      return "";
    })
    .filter(Boolean);
}

function updateItem(
  projection: TurnWorkflowProjection,
  itemId: ItemId,
  update: (item: WorkflowItem) => WorkflowItem,
): TurnWorkflowProjection {
  return {
    ...projection,
    items: projection.items.map((item) =>
      item.itemId === itemId ? update(item) : item,
    ),
  };
}

function earlierTimestamp(current: string | null, candidate: string): string {
  if (!current) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

export function workflowPhaseLabel(phase: WorkflowPhase): string {
  switch (phase) {
    case "starting":
      return "Starting";
    case "working":
      return "Working";
    case "waiting_for_approval":
      return "Waiting for approval";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
  }
}
