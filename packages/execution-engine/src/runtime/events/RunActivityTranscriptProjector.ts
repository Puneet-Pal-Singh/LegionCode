import {
  RUN_EVENT_TYPES,
  type RunEvent,
  type TurnActivityEvent,
  type TurnActivityEventStatus,
  type TurnActivityTranscriptPart,
} from "@repo/shared-types";

interface ProjectRunActivityTranscriptParams {
  runId: string;
  sessionId: string;
  events: RunEvent[];
  terminalStatus: "paused" | "failed" | "cancelled" | "completed";
  terminalReason?: string;
}

interface TranscriptBuilderState {
  runId: string;
  sessionId: string;
  sequence: number;
  turnIndex: number;
  currentTurnId: string;
  events: TurnActivityEvent[];
  toolEventIndexes: Map<string, number>;
}

export function projectRunActivityTranscript(
  params: ProjectRunActivityTranscriptParams,
): TurnActivityTranscriptPart {
  const state = createTranscriptBuilderState(params.runId, params.sessionId);
  const orderedEvents = [...params.events].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );

  for (const event of orderedEvents) {
    updateTurnScope(state, event);
    projectEvent(state, event);
  }

  const finalizedEvents = finalizeOpenActivityEvents(
    state.events,
    mapTerminalStatus(params.terminalStatus),
    params.terminalReason,
  );

  return {
    version: 1,
    type: "turn_activity",
    events: selectCurrentTurnEvents(finalizedEvents, state.currentTurnId),
    compacted: false,
  };
}

function createTranscriptBuilderState(
  runId: string,
  sessionId: string,
): TranscriptBuilderState {
  return {
    runId,
    sessionId,
    sequence: 0,
    turnIndex: 1,
    currentTurnId: `${runId}:turn-1`,
    events: [],
    toolEventIndexes: new Map(),
  };
}

function updateTurnScope(state: TranscriptBuilderState, event: RunEvent): void {
  if (
    event.type !== RUN_EVENT_TYPES.MESSAGE_EMITTED ||
    event.payload.role !== "user"
  ) {
    return;
  }

  state.currentTurnId =
    readClientMessageId(event.payload.metadata) ??
    `${state.runId}:turn-${state.turnIndex}`;
  state.turnIndex += 1;
}

function projectEvent(state: TranscriptBuilderState, event: RunEvent): void {
  switch (event.type) {
    case RUN_EVENT_TYPES.RUN_STATUS_CHANGED:
      projectStatusChangedEvent(state, event);
      return;
    case RUN_EVENT_TYPES.RUN_PROGRESS:
      appendActivityEvent(state, {
        id: event.eventId,
        kind: "progress",
        status: event.payload.status === "active" ? "running" : "completed",
        title: event.payload.label,
        detail: event.payload.summary,
        displayMode: event.payload.displayMode ?? "visible",
        metadata: {
          phase: event.payload.phase,
          ...event.payload.metadata,
        },
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
      return;
    case RUN_EVENT_TYPES.TOOL_REQUESTED:
      projectToolRequestedEvent(state, event);
      return;
    case RUN_EVENT_TYPES.TOOL_STARTED:
      updateToolActivityStatus(state, event.payload.toolId, "running", event);
      return;
    case RUN_EVENT_TYPES.TOOL_COMPLETED:
      projectToolCompletedEvent(state, event);
      return;
    case RUN_EVENT_TYPES.TOOL_FAILED:
      projectToolFailedEvent(state, event);
      return;
    case RUN_EVENT_TYPES.APPROVAL_REQUESTED:
      appendActivityEvent(state, {
        id: event.eventId,
        kind: "approval",
        status: "pending",
        title: event.payload.request.title,
        detail: event.payload.request.reason,
        displayMode: "visible",
        metadata: { requestId: event.payload.request.requestId },
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
      return;
    case RUN_EVENT_TYPES.MESSAGE_EMITTED:
      projectAssistantMessageEvent(state, event);
      return;
    default:
      return;
  }
}

function projectStatusChangedEvent(
  state: TranscriptBuilderState,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.RUN_STATUS_CHANGED }>,
): void {
  if (!event.payload.workflowStep) {
    return;
  }

  appendActivityEvent(state, {
    id: event.eventId,
    kind: "thinking",
    status: event.payload.newStatus === "running" ? "running" : "completed",
    title: `Working through ${event.payload.workflowStep}`,
    detail: event.payload.reason,
    displayMode: "collapsed",
    metadata: { workflowStep: event.payload.workflowStep },
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
  });
}

function projectToolRequestedEvent(
  state: TranscriptBuilderState,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.TOOL_REQUESTED }>,
): void {
  const activityEvent = appendActivityEvent(state, {
    id: event.eventId,
    kind: "tool_call",
    status: "pending",
    title: event.payload.displayText ?? event.payload.toolName,
    detail: event.payload.description,
    displayMode: "visible",
    metadata: {
      toolId: event.payload.toolId,
      toolName: event.payload.toolName,
    },
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
  });
  state.toolEventIndexes.set(event.payload.toolId, activityEvent.sequence - 1);
}

function projectToolCompletedEvent(
  state: TranscriptBuilderState,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.TOOL_COMPLETED }>,
): void {
  updateToolActivityStatus(state, event.payload.toolId, "completed", event);
  appendActivityEvent(state, {
    id: `${event.eventId}:result`,
    kind: "tool_result",
    status: "completed",
    title: `${event.payload.toolName} completed`,
    displayMode: "collapsed",
    metadata: {
      toolId: event.payload.toolId,
      toolName: event.payload.toolName,
      executionTimeMs: event.payload.executionTimeMs,
    },
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
  });
}

function projectToolFailedEvent(
  state: TranscriptBuilderState,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.TOOL_FAILED }>,
): void {
  updateToolActivityStatus(state, event.payload.toolId, "failed", event);
  appendActivityEvent(state, {
    id: `${event.eventId}:result`,
    kind: "tool_result",
    status: "failed",
    title: `${event.payload.toolName} failed`,
    detail: event.payload.error,
    displayMode: "visible",
    metadata: {
      toolId: event.payload.toolId,
      toolName: event.payload.toolName,
      executionTimeMs: event.payload.executionTimeMs,
    },
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
  });
}

function projectAssistantMessageEvent(
  state: TranscriptBuilderState,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.MESSAGE_EMITTED }>,
): void {
  if (event.payload.role !== "assistant") {
    return;
  }

  if (event.payload.transcriptPhase === "commentary") {
    appendActivityEvent(state, {
      id: `${event.eventId}:commentary`,
      kind: "thinking",
      status:
        event.payload.transcriptStatus === "active" ? "running" : "completed",
      title: "Thinking",
      detail: event.payload.content,
      displayMode: "collapsed",
      metadata: event.payload.metadata,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    });
    return;
  }

  const metadata = event.payload.metadata;
  if (metadata?.code !== "PROVIDER_UNAVAILABLE") {
    return;
  }

  appendActivityEvent(state, {
    id: `${event.eventId}:provider-error`,
    kind: "provider_error",
    status: "paused",
    title: "Provider interruption",
    detail: "The selected model stopped responding after retrying.",
    displayMode: "visible",
    metadata,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
  });
}

function readClientMessageId(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const value = metadata?.clientMessageId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function selectCurrentTurnEvents(
  events: TurnActivityEvent[],
  currentTurnId: string,
): TurnActivityEvent[] {
  return events
    .filter((event) => event.turnId === currentTurnId)
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}

function updateToolActivityStatus(
  state: TranscriptBuilderState,
  toolId: string,
  status: TurnActivityEventStatus,
  event: RunEvent,
): void {
  const index = state.toolEventIndexes.get(toolId);
  if (index === undefined) {
    return;
  }

  const existing = state.events[index];
  if (!existing) {
    return;
  }

  state.events[index] = {
    ...existing,
    status,
    updatedAt: event.timestamp,
  };
}

function appendActivityEvent(
  state: TranscriptBuilderState,
  input: Omit<TurnActivityEvent, "runId" | "sessionId" | "turnId" | "sequence">,
): TurnActivityEvent {
  state.sequence += 1;
  const event = {
    ...input,
    runId: state.runId,
    sessionId: state.sessionId,
    turnId: state.currentTurnId,
    sequence: state.sequence,
  } satisfies TurnActivityEvent;
  state.events.push(event);
  return event;
}

function finalizeOpenActivityEvents(
  events: TurnActivityEvent[],
  status: TurnActivityEventStatus,
  terminalReason: string | undefined,
): TurnActivityEvent[] {
  return events.map((event) => {
    if (event.status !== "pending" && event.status !== "running") {
      return event;
    }

    return {
      ...event,
      status,
      detail: event.detail ?? terminalReason,
    };
  });
}

function mapTerminalStatus(
  status: ProjectRunActivityTranscriptParams["terminalStatus"],
): TurnActivityEventStatus {
  if (status === "failed") {
    return "failed";
  }
  if (status === "completed") {
    return "completed";
  }
  return "paused";
}
