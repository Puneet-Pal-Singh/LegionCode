import {
  ACTIVITY_PART_KINDS,
  COMMENTARY_ACTIVITY_PHASES,
  COMMENTARY_ACTIVITY_STATUSES,
  MESSAGE_TRANSCRIPT_PHASES,
  RUN_EVENT_TYPES,
  TOOL_ACTIVITY_FAMILIES,
  TOOL_ACTIVITY_STATUSES,
  type ActivityFeedSnapshot,
  type ActivityPart,
  type RunEvent,
  type ToolActivityMetadata,
  type ToolActivityPart,
} from "@repo/shared-types";

export function projectRunEventsToActivitySnapshot(input: {
  runId: string;
  events: RunEvent[];
  isActive: boolean;
  fallbackSessionId?: string;
}): ActivityFeedSnapshot | null {
  const events = input.events
    .filter((event) => event.runId === input.runId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  if (events.length === 0) return null;

  const state = createProjectionState(input.runId);
  for (const event of events) {
    state.currentTurnId = resolveNextTurnId(state, event);
    projectEvent(state, event);
  }

  return {
    runId: input.runId,
    sessionId: resolveSessionId(events, input.fallbackSessionId),
    status: resolveActivityStatus(events, input.isActive),
    items: state.items.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
  };
}

export function isRunEventActivityOpen(input: {
  runId: string;
  events: RunEvent[];
}): boolean {
  const events = input.events
    .filter((event) => event.runId === input.runId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return events.length > 0 && resolveActivityStatus(events, false) === "RUNNING";
}

export function mergeActivitySnapshots(
  persisted: ActivityFeedSnapshot | null,
  live: ActivityFeedSnapshot | null,
): ActivityFeedSnapshot | null {
  if (!persisted) return live;
  if (!live) return persisted;

  const itemsById = new Map<string, ActivityPart>();
  for (const item of persisted.items) itemsById.set(item.id, item);
  for (const item of live.items) itemsById.set(item.id, item);

  return {
    runId: persisted.runId,
    sessionId: live.sessionId ?? persisted.sessionId,
    status: live.status ?? persisted.status,
    items: [...itemsById.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
  };
}

interface ProjectionState {
  runId: string;
  turnIndex: number;
  currentTurnId?: string;
  items: ActivityPart[];
  tools: Map<string, ToolActivityPart>;
}

function createProjectionState(runId: string): ProjectionState {
  return {
    runId,
    turnIndex: 0,
    items: [],
    tools: new Map(),
  };
}

function resolveNextTurnId(
  state: ProjectionState,
  event: RunEvent,
): string | undefined {
  if (
    event.type !== RUN_EVENT_TYPES.MESSAGE_EMITTED ||
    event.payload.role !== "user"
  ) {
    return state.currentTurnId;
  }

  state.turnIndex += 1;
  return readClientMessageId(event.payload.metadata) ?? `turn-${state.turnIndex}`;
}

function projectEvent(state: ProjectionState, event: RunEvent): void {
  switch (event.type) {
    case RUN_EVENT_TYPES.MESSAGE_EMITTED:
      projectMessageEvent(state, event);
      return;
    case RUN_EVENT_TYPES.RUN_PROGRESS:
      pushReasoningEvent(state, event);
      return;
    case RUN_EVENT_TYPES.TOOL_REQUESTED:
      projectToolRequested(state, event);
      return;
    case RUN_EVENT_TYPES.TOOL_STARTED:
      updateTool(state, event.payload.toolId, {
        status: TOOL_ACTIVITY_STATUSES.RUNNING,
        startedAt: event.timestamp,
        updatedAt: event.timestamp,
      });
      return;
    case RUN_EVENT_TYPES.TOOL_COMPLETED:
      updateTool(state, event.payload.toolId, {
        status: TOOL_ACTIVITY_STATUSES.COMPLETED,
        endedAt: event.timestamp,
        updatedAt: event.timestamp,
        output: event.payload.result,
      });
      return;
    case RUN_EVENT_TYPES.TOOL_FAILED:
      updateTool(state, event.payload.toolId, {
        status: TOOL_ACTIVITY_STATUSES.FAILED,
        endedAt: event.timestamp,
        updatedAt: event.timestamp,
        output: { error: event.payload.error },
      });
      return;
    case RUN_EVENT_TYPES.APPROVAL_REQUESTED:
      state.items.push({
        id: `approval:${event.payload.request.requestId}`,
        runId: event.runId,
        sessionId: event.sessionId,
        turnId: state.currentTurnId,
        kind: ACTIVITY_PART_KINDS.APPROVAL,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
        source: event.source,
        approvalType: "permission",
        status: "requested",
        summary: event.payload.request.title,
        details: event.payload.request.reason,
        expiresAt: event.payload.request.expiresAt,
      });
      return;
  }
}

function pushReasoningEvent(
  state: ProjectionState,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.RUN_PROGRESS }>,
): void {
  const next: ActivityPart = {
    id: event.eventId,
    runId: event.runId,
    sessionId: event.sessionId,
    turnId: state.currentTurnId,
    kind: ACTIVITY_PART_KINDS.REASONING,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    source: event.source,
    label: event.payload.label || "Thinking",
    summary: event.payload.summary,
    phase: event.payload.phase,
    status: event.payload.status,
  };
  const previous = state.items[state.items.length - 1];
  if (isDuplicateLiveThinking(previous, next)) {
    state.items[state.items.length - 1] = next;
    return;
  }
  state.items.push(next);
}

function isDuplicateLiveThinking(
  previous: ActivityPart | undefined,
  next: ActivityPart,
): boolean {
  return (
    previous?.kind === ACTIVITY_PART_KINDS.REASONING &&
    next.kind === ACTIVITY_PART_KINDS.REASONING &&
    previous.turnId === next.turnId &&
    previous.label === "Thinking" &&
    next.label === "Thinking" &&
    previous.summary.trim() === "" &&
    next.summary.trim() === "" &&
    previous.status === "active" &&
    next.status === "active"
  );
}

function projectMessageEvent(
  state: ProjectionState,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.MESSAGE_EMITTED }>,
): void {
  if (event.payload.role === "assistant" && isCommentaryEvent(event)) {
    state.items.push({
      id: event.eventId,
      runId: event.runId,
      sessionId: event.sessionId,
      turnId: state.currentTurnId,
      kind: ACTIVITY_PART_KINDS.COMMENTARY,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      source: event.source,
      phase:
        event.payload.transcriptPhase === MESSAGE_TRANSCRIPT_PHASES.FINAL_ANSWER
          ? COMMENTARY_ACTIVITY_PHASES.FINAL_ANSWER
          : COMMENTARY_ACTIVITY_PHASES.COMMENTARY,
      status:
        event.payload.transcriptStatus ?? COMMENTARY_ACTIVITY_STATUSES.COMPLETED,
      text: event.payload.content,
      metadata: event.payload.metadata,
    });
    return;
  }

  state.items.push({
    id: event.eventId,
    runId: event.runId,
    sessionId: event.sessionId,
    turnId: state.currentTurnId,
    kind: ACTIVITY_PART_KINDS.TEXT,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    source: event.source,
    role: event.payload.role,
    content: event.payload.content,
    metadata: event.payload.metadata,
  });
}

function projectToolRequested(
  state: ProjectionState,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.TOOL_REQUESTED }>,
): void {
  const tool: ToolActivityPart = {
    id: event.eventId,
    runId: event.runId,
    sessionId: event.sessionId,
    turnId: state.currentTurnId,
    kind: ACTIVITY_PART_KINDS.TOOL,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    source: event.source,
    toolId: event.payload.toolId,
    toolName: event.payload.toolName,
    status: TOOL_ACTIVITY_STATUSES.REQUESTED,
    input: event.payload.arguments,
    metadata: buildToolMetadata(event.payload.toolName, event.payload.arguments),
  };
  state.tools.set(tool.toolId, tool);
  state.items.push(tool);
}

function buildToolMetadata(
  toolName: string,
  input: Record<string, unknown>,
): ToolActivityMetadata {
  if (toolName === "read_file") {
    return {
      family: TOOL_ACTIVITY_FAMILIES.READ,
      path: readString(input.path),
      count: 0,
      truncated: false,
      loadedPaths: [],
    };
  }
  if (toolName === "glob" || toolName === "grep" || toolName === "search_code") {
    return {
      family: TOOL_ACTIVITY_FAMILIES.SEARCH,
      path: readString(input.path),
      pattern: readString(input.pattern) ?? readString(input.glob),
      count: 0,
      truncated: false,
      loadedPaths: [],
    };
  }
  return {
    family: TOOL_ACTIVITY_FAMILIES.GENERIC,
    summary: toolName,
  };
}

function updateTool(
  state: ProjectionState,
  toolId: string,
  patch: Partial<ToolActivityPart>,
): void {
  const tool = state.tools.get(toolId);
  if (!tool) return;
  Object.assign(tool, patch);
}

function isCommentaryEvent(
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.MESSAGE_EMITTED }>,
): boolean {
  return (
    event.payload.transcriptPhase === MESSAGE_TRANSCRIPT_PHASES.COMMENTARY ||
    event.payload.transcriptPhase === MESSAGE_TRANSCRIPT_PHASES.FINAL_ANSWER
  );
}

function resolveActivityStatus(
  events: RunEvent[],
  isActive: boolean,
): "RUNNING" | "COMPLETED" | "FAILED" | null {
  const lifecycleEvent = [...events].reverse().find(isRunLifecycleEvent);
  const openActivityEvent = [...events].reverse().find(isOpenActivityEvent);
  if (
    openActivityEvent &&
    (!lifecycleEvent || openActivityEvent.timestamp > lifecycleEvent.timestamp)
  ) {
    return "RUNNING";
  }
  if (lifecycleEvent?.type === RUN_EVENT_TYPES.RUN_COMPLETED) {
    return "COMPLETED";
  }
  if (lifecycleEvent?.type === RUN_EVENT_TYPES.RUN_FAILED) {
    return "FAILED";
  }
  if (lifecycleEvent?.type === RUN_EVENT_TYPES.RUN_STATUS_CHANGED) {
    return isOpenRunStatus(lifecycleEvent.payload.newStatus)
      ? "RUNNING"
      : null;
  }
  if (lifecycleEvent?.type === RUN_EVENT_TYPES.RUN_STARTED) {
    return "RUNNING";
  }
  if (isActive || Boolean(openActivityEvent)) {
    return "RUNNING";
  }
  return null;
}

function isRunLifecycleEvent(event: RunEvent): boolean {
  return (
    event.type === RUN_EVENT_TYPES.RUN_STARTED ||
    event.type === RUN_EVENT_TYPES.RUN_STATUS_CHANGED ||
    event.type === RUN_EVENT_TYPES.RUN_COMPLETED ||
    event.type === RUN_EVENT_TYPES.RUN_FAILED
  );
}

function isOpenRunStatus(status: string): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting" ||
    status === "paused"
  );
}

function isOpenActivityEvent(event: RunEvent): boolean {
  switch (event.type) {
    case RUN_EVENT_TYPES.MESSAGE_EMITTED:
      return event.payload.role === "user";
    case RUN_EVENT_TYPES.RUN_PROGRESS:
      return event.payload.status === "active";
    case RUN_EVENT_TYPES.APPROVAL_REQUESTED:
    case RUN_EVENT_TYPES.TOOL_REQUESTED:
    case RUN_EVENT_TYPES.TOOL_STARTED:
    case RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED:
      return true;
    default:
      return false;
  }
}

function resolveSessionId(
  events: RunEvent[],
  fallbackSessionId: string | undefined,
): string | undefined {
  return events.find((event) => event.sessionId)?.sessionId ?? fallbackSessionId;
}

function readClientMessageId(
  metadata: Record<string, unknown> | undefined,
): string | null {
  return readString(metadata?.clientMessageId) ?? null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
