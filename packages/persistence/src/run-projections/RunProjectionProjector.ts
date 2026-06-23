import {
  RunItemSchema,
  RunSchema,
  type PlatformEvent,
  type Run,
  type RunId,
  type RunItem,
} from "@repo/platform-protocol";
import {
  RUN_PROJECTION_VERSION,
  RunProjectionError,
  parseApprovalProjection,
  parseToolCallProjection,
  type ApprovalProjection,
  type RunProjectionEventInput,
  type RunProjectionSnapshot,
  type ToolCallProjection,
} from "./types.js";

interface ProjectionState {
  run: Run | null;
  itemsById: Map<string, RunItem>;
  toolCallsById: Map<string, ToolCallProjection>;
  approvalsById: Map<string, ApprovalProjection>;
  lastCursor: RunProjectionSnapshot["lastCursor"] | null;
  lastProjectionSequence: number;
}

export function projectRunEvents(
  runId: RunId,
  inputs: readonly RunProjectionEventInput[],
): RunProjectionSnapshot | null {
  const state: ProjectionState = {
    run: null,
    itemsById: new Map(),
    toolCallsById: new Map(),
    approvalsById: new Map(),
    lastCursor: null,
    lastProjectionSequence: 0,
  };

  for (const input of inputs) {
    applyProjectionInput(state, runId, input);
  }

  if (!state.run) {
    return null;
  }

  return {
    run: state.run,
    items: sortBySequence([...state.itemsById.values()]),
    toolCalls: sortBySequence([...state.toolCallsById.values()]),
    approvals: sortBySequence([...state.approvalsById.values()]),
    lastCursor: requireLastCursor(state),
    projectionVersion: RUN_PROJECTION_VERSION,
  };
}

function applyProjectionInput(
  state: ProjectionState,
  runId: RunId,
  input: RunProjectionEventInput,
): void {
  validateProjectionInput(runId, input, state.lastProjectionSequence + 1);
  state.lastCursor = input.event.cursor;
  state.lastProjectionSequence = input.projectionSequence;

  if (isRunLifecycleEvent(input.event)) {
    state.run = projectRunState(input.event, input.projectionSequence);
    return;
  }

  if (isRunItemEvent(input.event)) {
    state.itemsById.set(
      input.event.payload.item.id,
      projectRunItem(input.event, input.projectionSequence),
    );
    return;
  }

  if (isAssistantTextEvent(input.event)) {
    projectAssistantText(state, input.event, input.projectionSequence);
    return;
  }

  if (isToolCallEvent(input.event)) {
    projectToolCall(state, input.event, input.projectionSequence);
    return;
  }

  if (isApprovalEvent(input.event)) {
    projectApproval(state, input.event, input.projectionSequence);
  }
}

function validateProjectionInput(
  runId: RunId,
  input: RunProjectionEventInput,
  expectedSequence: number,
): void {
  if (
    !Number.isSafeInteger(input.projectionSequence) ||
    input.projectionSequence < 1
  ) {
    throw new RunProjectionError(
      "invalid_projection_sequence",
      "Projection sequence must be a positive safe integer",
    );
  }
  if (input.projectionSequence !== expectedSequence) {
    throw new RunProjectionError(
      "invalid_projection_sequence",
      `Projection sequence must be ${expectedSequence}, received ${input.projectionSequence}`,
    );
  }
  if (input.event.runId !== runId) {
    throw new RunProjectionError(
      "event_run_mismatch",
      "Projection event does not belong to the requested run",
    );
  }
  if (input.event.scopeType !== "run" || input.event.scopeId !== runId) {
    throw new RunProjectionError(
      "event_scope_mismatch",
      "Run projection only accepts run-scoped events",
    );
  }
}

function isRunLifecycleEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `run.${string}` }> {
  return event.type.startsWith("run.");
}

function isRunItemEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `item.${string}` }> {
  return event.type.startsWith("item.");
}

function isAssistantTextEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `assistant.text.${string}` }> {
  return event.type.startsWith("assistant.text.");
}

function isToolCallEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `tool.call.${string}` }> {
  return event.type.startsWith("tool.call.");
}

function isApprovalEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `approval.${string}` }> {
  return event.type.startsWith("approval.");
}

function projectRunState(
  event: Extract<PlatformEvent, { type: `run.${string}` }>,
  projectionSequence: number,
): Run {
  return RunSchema.parse({
    ...event.payload.run,
    lastEventSequence: projectionSequence,
  });
}

function projectRunItem(
  event: Extract<PlatformEvent, { type: `item.${string}` }>,
  projectionSequence: number,
): RunItem {
  return RunItemSchema.parse({
    ...event.payload.item,
    eventSequence: projectionSequence,
  });
}

function projectAssistantText(
  state: ProjectionState,
  event: Extract<PlatformEvent, { type: `assistant.text.${string}` }>,
  projectionSequence: number,
): void {
  const item = state.itemsById.get(event.payload.itemId);
  if (!item) {
    throw new RunProjectionError(
      "missing_text_item",
      `Missing assistant text item: ${event.payload.itemId}`,
    );
  }
  if (event.type === "assistant.text.delta") {
    state.itemsById.set(
      item.id,
      updateAssistantTextItem(
        item,
        getAssistantText(item) + event.payload.delta,
        projectionSequence,
      ),
    );
    return;
  }
  state.itemsById.set(
    item.id,
    updateAssistantTextItem(item, event.payload.text, projectionSequence),
  );
}

function updateAssistantTextItem(
  item: RunItem,
  text: string,
  projectionSequence: number,
): RunItem {
  if (item.type !== "assistant_message") {
    throw new RunProjectionError(
      "missing_text_item",
      `Assistant text event targeted non-assistant item: ${item.id}`,
    );
  }
  return RunItemSchema.parse({
    ...item,
    content: {
      ...item.content,
      text,
    },
    eventSequence: projectionSequence,
  });
}

function getAssistantText(item: RunItem): string {
  if (item.type !== "assistant_message") {
    return "";
  }
  const value = item.content.text;
  return typeof value === "string" ? value : "";
}

function projectToolCall(
  state: ProjectionState,
  event: Extract<PlatformEvent, { type: `tool.call.${string}` }>,
  projectionSequence: number,
): void {
  if (event.type === "tool.call.requested") {
    state.toolCallsById.set(
      event.payload.content.toolCallId,
      parseToolCallProjection({
        toolCallId: event.payload.content.toolCallId,
        runId: requireEventRunId(event),
        threadId: event.threadId,
        itemId: event.payload.itemId,
        toolName: event.payload.content.toolName,
        status: "requested",
        input: event.payload.content.input,
        output: null,
        outputText: "",
        failure: null,
        requestedAt: event.createdAt,
        startedAt: null,
        completedAt: null,
        eventSequence: projectionSequence,
      }),
    );
    return;
  }

  const current = requireToolCall(state, event.payload.toolCallId);
  if (event.type === "tool.call.started") {
    state.toolCallsById.set(
      current.toolCallId,
      parseToolCallProjection({
        ...current,
        status: "running",
        startedAt: event.createdAt,
        eventSequence: projectionSequence,
      }),
    );
    return;
  }
  if (event.type === "tool.call.output.delta") {
    state.toolCallsById.set(
      current.toolCallId,
      parseToolCallProjection({
        ...current,
        status: current.status === "requested" ? "running" : current.status,
        outputText: current.outputText + event.payload.delta,
        eventSequence: projectionSequence,
      }),
    );
    return;
  }
  if (event.type === "tool.call.completed") {
    state.toolCallsById.set(
      current.toolCallId,
      parseToolCallProjection({
        ...current,
        status: "completed",
        output: event.payload.output,
        completedAt: event.createdAt,
        eventSequence: projectionSequence,
      }),
    );
    return;
  }
  state.toolCallsById.set(
    current.toolCallId,
    parseToolCallProjection({
      ...current,
      status: "failed",
      failure: event.payload.failure,
      completedAt: event.createdAt,
      eventSequence: projectionSequence,
    }),
  );
}

function requireToolCall(
  state: ProjectionState,
  toolCallId: string,
): ToolCallProjection {
  const toolCall = state.toolCallsById.get(toolCallId);
  if (!toolCall) {
    throw new RunProjectionError(
      "missing_tool_request",
      `Missing tool call request: ${toolCallId}`,
    );
  }
  return toolCall;
}

function requireEventRunId(event: PlatformEvent): RunId {
  if (event.runId === null) {
    throw new RunProjectionError(
      "event_run_mismatch",
      "Run projection event is missing a run ID",
    );
  }
  return event.runId;
}

function projectApproval(
  state: ProjectionState,
  event: Extract<PlatformEvent, { type: `approval.${string}` }>,
  projectionSequence: number,
): void {
  if (event.type === "approval.requested") {
    state.approvalsById.set(
      event.payload.approvalId,
      parseApprovalProjection({
        approvalId: event.payload.approvalId,
        runId: requireEventRunId(event),
        threadId: event.threadId,
        itemId: event.payload.itemId,
        status: "requested",
        question: event.payload.question,
        options: event.payload.options,
        metadata: event.payload.metadata,
        decision: null,
        decidedBy: null,
        reason: null,
        requestedAt: event.createdAt,
        decidedAt: null,
        eventSequence: projectionSequence,
      }),
    );
    return;
  }

  const current = state.approvalsById.get(event.payload.approvalId);
  if (!current) {
    throw new RunProjectionError(
      "approval_not_requested",
      `Missing approval request: ${event.payload.approvalId}`,
    );
  }
  state.approvalsById.set(
    current.approvalId,
    parseApprovalProjection({
      ...current,
      status: "decided",
      decision: event.payload.decision,
      decidedBy: event.payload.decidedBy,
      reason: event.payload.reason,
      decidedAt: event.createdAt,
      eventSequence: projectionSequence,
    }),
  );
}

function requireLastCursor(
  state: ProjectionState,
): RunProjectionSnapshot["lastCursor"] {
  if (state.lastCursor === null) {
    throw new RunProjectionError(
      "missing_run_created",
      "Run projection has no cursor",
    );
  }
  return state.lastCursor;
}

function sortBySequence<T extends { eventSequence: number }>(
  values: readonly T[],
): T[] {
  return [...values].sort(
    (left, right) => left.eventSequence - right.eventSequence,
  );
}
