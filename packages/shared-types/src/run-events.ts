/**
 * Run Events - Canonical event types and envelopes for Shadowbox runs
 * Shared contract used across web, brain, and muscle layers
 */

import { RunStatus } from "./run-status.js";
import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  ApprovalResolutionStatus,
} from "./approval-policy.js";

/** Event source identifier */
export type EventSource = "brain" | "muscle" | "web" | "cli" | "desktop";

/** Canonical workflow stages for user-visible run progress */
export const RUN_WORKFLOW_STEPS = {
  PLANNING: "planning",
  EXECUTION: "execution",
  SYNTHESIS: "synthesis",
} as const;

export type RunWorkflowStep =
  (typeof RUN_WORKFLOW_STEPS)[keyof typeof RUN_WORKFLOW_STEPS];

export const PROVIDER_FAILURE_CODES = [
  "PROVIDER_UNAVAILABLE",
  "MODEL_TIMEOUT",
  "MODEL_UNUSABLE_RESPONSE",
] as const;

export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

export interface ProviderFailureMetadata {
  code: ProviderFailureCode;
  retryable: boolean;
  providerId: string | null;
  modelId: string | null;
  statusCode: number | null;
  retryCount: number;
  lastCompletedAction: string | null;
  stepsExecuted: number;
  toolExecutionCount: number;
  completedMutatingToolCount: number;
  completedReadOnlyToolCount: number;
  noFilesChanged: boolean;
}

export const TURN_ACTIVITY_EVENT_KINDS = [
  "thinking",
  "progress",
  "tool_call",
  "tool_result",
  "file_edit",
  "approval",
  "provider_error",
  "summary",
] as const;

export type TurnActivityEventKind = (typeof TURN_ACTIVITY_EVENT_KINDS)[number];

export const TURN_ACTIVITY_EVENT_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "paused",
] as const;

export type TurnActivityEventStatus =
  (typeof TURN_ACTIVITY_EVENT_STATUSES)[number];

export interface TurnActivityEvent {
  id: string;
  runId: string;
  sessionId: string;
  turnId: string;
  sequence: number;
  kind: TurnActivityEventKind;
  status: TurnActivityEventStatus;
  title: string;
  detail?: string;
  displayMode: "visible" | "collapsed" | "debug";
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TurnActivityTranscriptPart {
  version: 1;
  type: "turn_activity";
  events: TurnActivityEvent[];
  compacted: boolean;
}

export const MESSAGE_TRANSCRIPT_PHASES = {
  PROMPT: "prompt",
  COMMENTARY: "commentary",
  FINAL_ANSWER: "final_answer",
} as const;

export type MessageTranscriptPhase =
  (typeof MESSAGE_TRANSCRIPT_PHASES)[keyof typeof MESSAGE_TRANSCRIPT_PHASES];

export const MESSAGE_TRANSCRIPT_STATUSES = {
  ACTIVE: "active",
  COMPLETED: "completed",
} as const;

export type MessageTranscriptStatus =
  (typeof MESSAGE_TRANSCRIPT_STATUSES)[keyof typeof MESSAGE_TRANSCRIPT_STATUSES];

/** Canonical run event types */
export const RUN_EVENT_TYPES = {
  RUN_STARTED: "run.started",
  RUN_STATUS_CHANGED: "run.status.changed",
  RUN_PROGRESS: "run.progress",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_RESOLVED: "approval.resolved",
  MESSAGE_EMITTED: "message.emitted",
  TOOL_REQUESTED: "tool.requested",
  TOOL_STARTED: "tool.started",
  TOOL_OUTPUT_APPENDED: "tool.output.appended",
  TOOL_COMPLETED: "tool.completed",
  TOOL_FAILED: "tool.failed",
  RUN_COMPLETED: "run.completed",
  RUN_FAILED: "run.failed",
} as const;

export type RunEventType =
  (typeof RUN_EVENT_TYPES)[keyof typeof RUN_EVENT_TYPES];

/**
 * Generic event envelope structure used for all run events
 * Supports type-safe discriminated unions via TType
 */
export interface RunEventEnvelope<
  TType extends RunEventType = RunEventType,
  TPayload = unknown,
> {
  version: 1;
  eventId: string;
  runId: string;
  sessionId?: string;
  timestamp: string;
  source: EventSource;
  type: TType;
  payload: TPayload;
}

// ============================================================================
// Event Payload Definitions
// ============================================================================

export interface RunStartedPayload {
  status: Extract<RunStatus, "queued" | "running">;
}

export interface RunStatusChangedPayload {
  previousStatus: RunStatus;
  newStatus: RunStatus;
  workflowStep?: RunWorkflowStep;
  reason?: string;
}

export interface RunProgressPayload {
  phase: RunWorkflowStep;
  label: string;
  summary: string;
  status: "active" | "completed";
  displayMode?: "visible" | "collapsed" | "debug";
  metadata?: Record<string, unknown>;
}

export interface ApprovalRequestedPayload {
  request: ApprovalRequest;
}

export interface ApprovalResolvedPayload {
  requestId: string;
  decision: ApprovalDecisionKind;
  status: ApprovalResolutionStatus;
  resolvedAt: string;
}

export interface MessageEmittedPayload {
  content: string;
  role: "user" | "assistant" | "system";
  metadata?: Record<string, unknown>;
  transcriptPhase?: MessageTranscriptPhase;
  transcriptStatus?: MessageTranscriptStatus;
}

export interface ToolRequestedPayload {
  toolId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  description?: string;
  displayText?: string;
}

export interface ToolStartedPayload {
  toolId: string;
  toolName: string;
}

type ToolOutputDelta =
  | { stdoutDelta: string; stderrDelta?: string }
  | { stdoutDelta?: string; stderrDelta: string };

export type ToolOutputAppendedPayload = {
  toolId: string;
  toolName: string;
  turnId?: string;
  truncated?: boolean;
} & ToolOutputDelta;

export interface ToolCompletedPayload {
  toolId: string;
  toolName: string;
  result?: unknown;
  executionTimeMs: number;
}

export interface ToolFailedPayload {
  toolId: string;
  toolName: string;
  error: string;
  executionTimeMs: number;
}

export interface RunCompletedPayload {
  status: Extract<RunStatus, "complete">;
  totalDurationMs: number;
  toolsUsed: number;
}

export interface RunFailedPayload {
  status: Extract<RunStatus, "failed">;
  error: string;
  totalDurationMs: number;
}

// ============================================================================
// Discriminated Union Types
// ============================================================================

export type RunStartedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.RUN_STARTED,
  RunStartedPayload
>;

export type RunStatusChangedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.RUN_STATUS_CHANGED,
  RunStatusChangedPayload
>;

export type RunProgressEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.RUN_PROGRESS,
  RunProgressPayload
>;

export type ApprovalRequestedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.APPROVAL_REQUESTED,
  ApprovalRequestedPayload
>;

export type ApprovalResolvedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.APPROVAL_RESOLVED,
  ApprovalResolvedPayload
>;

export type MessageEmittedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.MESSAGE_EMITTED,
  MessageEmittedPayload
>;

export type ToolRequestedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.TOOL_REQUESTED,
  ToolRequestedPayload
>;

export type ToolStartedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.TOOL_STARTED,
  ToolStartedPayload
>;

export type ToolOutputAppendedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED,
  ToolOutputAppendedPayload
>;

export type ToolCompletedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.TOOL_COMPLETED,
  ToolCompletedPayload
>;

export type ToolFailedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.TOOL_FAILED,
  ToolFailedPayload
>;

export type RunCompletedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.RUN_COMPLETED,
  RunCompletedPayload
>;

export type RunFailedEvent = RunEventEnvelope<
  typeof RUN_EVENT_TYPES.RUN_FAILED,
  RunFailedPayload
>;

/**
 * Discriminated union of all canonical run events
 * Use with type guards for type-safe event handling
 */
export type RunEvent =
  | RunStartedEvent
  | RunStatusChangedEvent
  | RunProgressEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | MessageEmittedEvent
  | ToolRequestedEvent
  | ToolStartedEvent
  | ToolOutputAppendedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | RunCompletedEvent
  | RunFailedEvent;

/**
 * Type guard to check if event is a run event
 */
export function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.type === "string" &&
    Object.values(RUN_EVENT_TYPES).includes(obj.type as RunEventType)
  );
}

/**
 * Type guard for specific event types
 */
export function isRunEventOfType<T extends RunEventType>(
  event: RunEvent,
  type: T,
): event is Extract<RunEvent, { type: T }> {
  return event.type === type;
}
