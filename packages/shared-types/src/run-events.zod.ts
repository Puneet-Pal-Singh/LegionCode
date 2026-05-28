/**
 * Run Events Zod Schemas - Type-safe validation for all run events
 * Ensures all events conform to canonical contract
 */

import { z } from "zod";
import {
  MESSAGE_TRANSCRIPT_PHASES,
  MESSAGE_TRANSCRIPT_STATUSES,
  RUN_EVENT_TYPES,
  RUN_WORKFLOW_STEPS,
  type RunEvent,
  type RunEventType,
  type ToolOutputAppendedPayload,
} from "./run-events.js";
import {
  ApprovalDecisionKindSchema,
  ProposedPersistentRuleSchema,
  ApprovalResolutionStatusSchema,
  RiskyActionCategorySchema,
} from "./approval-policy.js";
import { RUN_STATUSES } from "./run-status.js";

// ============================================================================
// Base Schemas
// ============================================================================

const EventSourceSchema = z.enum(["brain", "muscle", "web", "cli", "desktop"]);

const RunStatusSchema = z.enum([
  RUN_STATUSES.QUEUED,
  RUN_STATUSES.RUNNING,
  RUN_STATUSES.WAITING,
  RUN_STATUSES.PAUSED,
  RUN_STATUSES.FAILED,
  RUN_STATUSES.COMPLETE,
]);

const RunEventTypeSchema = z.enum([
  RUN_EVENT_TYPES.RUN_STARTED,
  RUN_EVENT_TYPES.RUN_STATUS_CHANGED,
  RUN_EVENT_TYPES.RUN_PROGRESS,
  RUN_EVENT_TYPES.APPROVAL_REQUESTED,
  RUN_EVENT_TYPES.APPROVAL_RESOLVED,
  RUN_EVENT_TYPES.MESSAGE_EMITTED,
  RUN_EVENT_TYPES.TOOL_REQUESTED,
  RUN_EVENT_TYPES.TOOL_STARTED,
  RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED,
  RUN_EVENT_TYPES.TOOL_COMPLETED,
  RUN_EVENT_TYPES.TOOL_FAILED,
  RUN_EVENT_TYPES.RUN_COMPLETED,
  RUN_EVENT_TYPES.RUN_FAILED,
]);

// ============================================================================
// Payload Schemas
// ============================================================================

const RunStartedPayloadSchema = z.object({
  status: z.enum(["queued", "running"]),
});

const RunStatusChangedPayloadSchema = z.object({
  previousStatus: RunStatusSchema,
  newStatus: RunStatusSchema,
  workflowStep: z
    .enum([
      RUN_WORKFLOW_STEPS.PLANNING,
      RUN_WORKFLOW_STEPS.EXECUTION,
      RUN_WORKFLOW_STEPS.SYNTHESIS,
    ])
    .optional(),
  reason: z.string().optional(),
});

const RunProgressPayloadSchema = z.object({
  phase: z.enum([
    RUN_WORKFLOW_STEPS.PLANNING,
    RUN_WORKFLOW_STEPS.EXECUTION,
    RUN_WORKFLOW_STEPS.SYNTHESIS,
  ]),
  label: z.string().min(1),
  summary: z.string(),
  status: z.enum(["active", "completed"]),
});

const ApprovalRequestPayloadSchema = z.object({
  request: z.object({
    requestId: z.string().min(1),
    runId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    itemId: z.string().min(1).optional(),
    origin: z.enum(["user", "agent"]),
    category: RiskyActionCategorySchema,
    title: z.string().min(1),
    reason: z.string().min(1),
    command: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    affectedPaths: z.array(z.string().min(1)).optional(),
    remoteTarget: z.string().min(1).optional(),
    actionFingerprint: z.string().min(1),
    availableDecisions: z.array(ApprovalDecisionKindSchema).min(1),
    proposedPersistentRule: ProposedPersistentRuleSchema.optional(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
  }),
});

const ApprovalResolvedPayloadSchema = z.object({
  requestId: z.string().min(1),
  decision: ApprovalDecisionKindSchema,
  status: ApprovalResolutionStatusSchema,
  resolvedAt: z.string().datetime(),
});

const MessageEmittedPayloadSchema = z.object({
  content: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  transcriptPhase: z
    .enum([
      MESSAGE_TRANSCRIPT_PHASES.PROMPT,
      MESSAGE_TRANSCRIPT_PHASES.COMMENTARY,
      MESSAGE_TRANSCRIPT_PHASES.FINAL_ANSWER,
    ])
    .optional(),
  transcriptStatus: z
    .enum([
      MESSAGE_TRANSCRIPT_STATUSES.ACTIVE,
      MESSAGE_TRANSCRIPT_STATUSES.COMPLETED,
    ])
    .optional(),
});

const ToolRequestedPayloadSchema = z.object({
  toolId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  description: z.string().trim().min(1).optional(),
  displayText: z.string().trim().min(1).optional(),
});

const ToolStartedPayloadSchema = z.object({
  toolId: z.string().min(1),
  toolName: z.string().min(1),
});

const ToolOutputAppendedBaseSchema = z.object({
  toolId: z.string().min(1),
  toolName: z.string().min(1),
  turnId: z.string().min(1).optional(),
  truncated: z.boolean().optional(),
});

const ToolOutputAppendedPayloadSchema: z.ZodType<ToolOutputAppendedPayload> =
  z.union([
    ToolOutputAppendedBaseSchema.extend({
      stdoutDelta: z.string().min(1),
      stderrDelta: z.string().min(1).optional(),
    }),
    ToolOutputAppendedBaseSchema.extend({
      stdoutDelta: z.string().min(1).optional(),
      stderrDelta: z.string().min(1),
    }),
  ]);

const ToolCompletedPayloadSchema = z.object({
  toolId: z.string().min(1),
  toolName: z.string().min(1),
  result: z.unknown().optional(),
  executionTimeMs: z.number().min(0),
});

const ToolFailedPayloadSchema = z.object({
  toolId: z.string().min(1),
  toolName: z.string().min(1),
  error: z.string().min(1),
  executionTimeMs: z.number().min(0),
});

const RunCompletedPayloadSchema = z.object({
  status: z.literal("complete"),
  totalDurationMs: z.number().min(0),
  toolsUsed: z.number().min(0),
});

const RunFailedPayloadSchema = z.object({
  status: z.literal("failed"),
  error: z.string().min(1),
  totalDurationMs: z.number().min(0),
});

// ============================================================================
// Event Envelope Schemas
// ============================================================================

const RunEventEnvelopeSchema = z.object({
  version: z.literal(1),
  eventId: z.string().min(1),
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  timestamp: z.string().datetime(),
  source: EventSourceSchema,
  type: RunEventTypeSchema,
  payload: z.unknown(),
});

// Discriminated union for type-safe parsing
const RunEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.RUN_STARTED),
      payload: RunStartedPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.RUN_STATUS_CHANGED),
      payload: RunStatusChangedPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.RUN_PROGRESS),
      payload: RunProgressPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.APPROVAL_REQUESTED),
      payload: ApprovalRequestPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.APPROVAL_RESOLVED),
      payload: ApprovalResolvedPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.MESSAGE_EMITTED),
      payload: MessageEmittedPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.TOOL_REQUESTED),
      payload: ToolRequestedPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.TOOL_STARTED),
      payload: ToolStartedPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED),
      payload: ToolOutputAppendedPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.TOOL_COMPLETED),
      payload: ToolCompletedPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.TOOL_FAILED),
      payload: ToolFailedPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.RUN_COMPLETED),
      payload: RunCompletedPayloadSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      eventId: z.string().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      timestamp: z.string().datetime(),
      source: EventSourceSchema,
      type: z.literal(RUN_EVENT_TYPES.RUN_FAILED),
      payload: RunFailedPayloadSchema,
    })
    .strict(),
]);

export type RunEventSchema = z.infer<typeof RunEventSchema>;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Parse and validate a run event
 * Throws ZodError on validation failure
 */
export function parseRunEvent(data: unknown): RunEvent {
  return RunEventSchema.parse(data);
}

/**
 * Safely parse a run event, returning result with error details
 */
export function safeParseRunEvent(
  data: unknown,
): { success: true; data: RunEvent } | { success: false; error: string } {
  const result = RunEventSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as RunEvent };
  }
  return {
    success: false,
    error: result.error.message,
  };
}

/**
 * Validate event envelope structure without payload validation
 */
export function validateEventEnvelope(
  data: unknown,
):
  | { success: true; data: z.infer<typeof RunEventEnvelopeSchema> }
  | { success: false; error: string } {
  const result = RunEventEnvelopeSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.message,
  };
}

/**
 * Get zod schema for specific event type
 * Useful for custom validation logic
 */
export function getEventPayloadSchema(type: RunEventType): z.ZodSchema | null {
  const schemas: Record<RunEventType, z.ZodSchema> = {
    [RUN_EVENT_TYPES.RUN_STARTED]: RunStartedPayloadSchema,
    [RUN_EVENT_TYPES.RUN_STATUS_CHANGED]: RunStatusChangedPayloadSchema,
    [RUN_EVENT_TYPES.RUN_PROGRESS]: RunProgressPayloadSchema,
    [RUN_EVENT_TYPES.APPROVAL_REQUESTED]: ApprovalRequestPayloadSchema,
    [RUN_EVENT_TYPES.APPROVAL_RESOLVED]: ApprovalResolvedPayloadSchema,
    [RUN_EVENT_TYPES.MESSAGE_EMITTED]: MessageEmittedPayloadSchema,
    [RUN_EVENT_TYPES.TOOL_REQUESTED]: ToolRequestedPayloadSchema,
    [RUN_EVENT_TYPES.TOOL_STARTED]: ToolStartedPayloadSchema,
    [RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED]: ToolOutputAppendedPayloadSchema,
    [RUN_EVENT_TYPES.TOOL_COMPLETED]: ToolCompletedPayloadSchema,
    [RUN_EVENT_TYPES.TOOL_FAILED]: ToolFailedPayloadSchema,
    [RUN_EVENT_TYPES.RUN_COMPLETED]: RunCompletedPayloadSchema,
    [RUN_EVENT_TYPES.RUN_FAILED]: RunFailedPayloadSchema,
  };

  return schemas[type] ?? null;
}
