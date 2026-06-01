import {
  MESSAGE_TRANSCRIPT_PHASES,
  MESSAGE_TRANSCRIPT_STATUSES,
  RUN_EVENT_TYPES,
  type ApprovalDecisionKind,
  type ApprovalRequest,
  type ApprovalResolutionStatus,
  type EventSource,
  type ApprovalRequestedEvent,
  type ApprovalResolvedEvent,
  type MessageTranscriptPhase,
  type MessageTranscriptStatus,
  type MessageEmittedEvent,
  type RunCompletedEvent,
  type RunEvent,
  type RunFailedEvent,
  type RunProgressEvent,
  type RunStartedEvent,
  type RunStatus,
  type RunStatusChangedEvent,
  type RunWorkflowStep,
  type ToolCompletedEvent,
  type ToolFailedEvent,
  type ToolOutputAppendedEvent,
  type ToolRequestedEvent,
  type ToolStartedEvent,
} from "@repo/shared-types";
import type { SerializedTask, TaskStatus } from "../types.js";

type RuntimeStatus =
  | TaskStatus
  | "CREATED"
  | "PLANNING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "PAUSED";

interface EventBaseInput {
  runId: string;
  sessionId?: string;
  source?: EventSource;
}

interface ToolEventInput extends EventBaseInput {
  taskId: string;
  toolName: string;
}

export function createRunStartedEvent(
  input: EventBaseInput,
  status: Extract<RunStatus, "queued" | "running"> = "queued",
): RunStartedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.RUN_STARTED, {
    status,
  });
}

export function createRunStatusChangedEvent(
  input: EventBaseInput,
  previousStatus: RunStatus,
  newStatus: RunStatus,
  workflowStep?: RunWorkflowStep,
  reason?: string,
): RunStatusChangedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.RUN_STATUS_CHANGED, {
    previousStatus,
    newStatus,
    workflowStep,
    reason,
  });
}

export function createRunProgressEvent(
  input: EventBaseInput,
  phase: RunWorkflowStep,
  label: string,
  summary: string,
  status: "active" | "completed",
): RunProgressEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.RUN_PROGRESS, {
    phase,
    label,
    summary,
    status,
  });
}

export function createApprovalRequestedEvent(
  input: EventBaseInput,
  request: ApprovalRequest,
): ApprovalRequestedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.APPROVAL_REQUESTED, {
    request,
  });
}

export function createApprovalResolvedEvent(
  input: EventBaseInput,
  payload: {
    requestId: string;
    decision: ApprovalDecisionKind;
    status: ApprovalResolutionStatus;
    resolvedAt?: string;
  },
): ApprovalResolvedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.APPROVAL_RESOLVED, {
    requestId: payload.requestId,
    decision: payload.decision,
    status: payload.status,
    resolvedAt: payload.resolvedAt ?? new Date().toISOString(),
  });
}

export function createToolRequestedEvent(
  input: ToolEventInput,
  arguments_: Record<string, unknown>,
  presentation?: {
    description?: string;
    displayText?: string;
  },
): ToolRequestedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.TOOL_REQUESTED, {
    toolId: input.taskId,
    toolName: input.toolName,
    arguments: arguments_,
    description: presentation?.description,
    displayText: presentation?.displayText,
  });
}

export function createToolStartedEvent(
  input: ToolEventInput,
): ToolStartedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.TOOL_STARTED, {
    toolId: input.taskId,
    toolName: input.toolName,
  });
}

export function createToolOutputAppendedEvent(
  input: ToolEventInput,
  chunk: {
    stdoutDelta?: string;
    stderrDelta?: string;
    turnId?: string;
    truncated?: boolean;
  },
): ToolOutputAppendedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED, {
    toolId: input.taskId,
    toolName: input.toolName,
    turnId: chunk.turnId,
    stdoutDelta: chunk.stdoutDelta,
    stderrDelta: chunk.stderrDelta,
    truncated: chunk.truncated,
  });
}

export function createToolCompletedEvent(
  input: ToolEventInput,
  result: unknown,
  executionTimeMs: number,
): ToolCompletedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.TOOL_COMPLETED, {
    toolId: input.taskId,
    toolName: input.toolName,
    result,
    executionTimeMs,
  });
}

export function createToolFailedEvent(
  input: ToolEventInput,
  error: string,
  executionTimeMs: number,
): ToolFailedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.TOOL_FAILED, {
    toolId: input.taskId,
    toolName: input.toolName,
    error,
    executionTimeMs,
  });
}

export function createRunCompletedEvent(
  input: EventBaseInput,
  totalDurationMs: number,
  toolsUsed: number,
): RunCompletedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.RUN_COMPLETED, {
    status: "complete",
    totalDurationMs,
    toolsUsed,
  });
}

export function createRunFailedEvent(
  input: EventBaseInput,
  error: string,
  totalDurationMs: number,
): RunFailedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.RUN_FAILED, {
    status: "failed",
    error,
    totalDurationMs,
  });
}

export function createMessageEmittedEvent(
  input: EventBaseInput,
  content: string,
  role: "user" | "assistant" | "system",
  metadata?: Record<string, unknown>,
  transcript?: {
    phase?: MessageTranscriptPhase;
    status?: MessageTranscriptStatus;
  },
): MessageEmittedEvent {
  return createEnvelope(input, RUN_EVENT_TYPES.MESSAGE_EMITTED, {
    content,
    role,
    metadata,
    transcriptPhase: transcript?.phase,
    transcriptStatus: transcript?.status,
  });
}

export const DEFAULT_USER_PROMPT_TRANSCRIPT = {
  phase: MESSAGE_TRANSCRIPT_PHASES.PROMPT,
  status: MESSAGE_TRANSCRIPT_STATUSES.COMPLETED,
} as const;

export const DEFAULT_ASSISTANT_FINAL_TRANSCRIPT = {
  phase: MESSAGE_TRANSCRIPT_PHASES.FINAL_ANSWER,
  status: MESSAGE_TRANSCRIPT_STATUSES.COMPLETED,
} as const;

export function mapRuntimeStatusToRunEventStatus(
  status: RuntimeStatus,
): RunStatus {
  switch (status) {
    case "RUNNING":
      return "running";
    case "FAILED":
      return "failed";
    case "COMPLETED":
      return "complete";
    case "PAUSED":
      return "paused";
    case "CANCELLED":
      return "waiting";
    case "CREATED":
    case "PLANNING":
    default:
      return "queued";
  }
}

export function toToolEventInput(
  runId: string,
  sessionId: string,
  task: Pick<SerializedTask, "id" | "type">,
): ToolEventInput {
  return {
    runId,
    sessionId,
    taskId: task.id,
    toolName: task.type,
  };
}

function createEnvelope<TEvent extends RunEvent["type"], TPayload>(
  input: EventBaseInput,
  type: TEvent,
  payload: TPayload,
): Extract<RunEvent, { type: TEvent }> {
  return {
    version: 1,
    eventId: crypto.randomUUID(),
    runId: input.runId,
    sessionId: input.sessionId,
    timestamp: new Date().toISOString(),
    source: input.source ?? "brain",
    type,
    payload,
  } as unknown as Extract<RunEvent, { type: TEvent }>;
}
