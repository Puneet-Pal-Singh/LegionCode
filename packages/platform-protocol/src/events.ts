import { z } from "zod";
import {
  EventSequenceSchema,
  ProtocolTimestampSchema,
} from "./common.js";
import {
  ArtifactReferenceItemContentSchema,
  JsonRecordSchema,
  RunSchema,
  ThreadItemSchema,
  ThreadSchema,
  ToolCallItemContentSchema,
  TurnSchema,
} from "./conversation.js";
import {
  ApprovalIdSchema,
  EventCursorSchema,
  EventIdSchema,
  ItemIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  ToolCallIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";

export const EVENT_SCHEMA_VERSION = 1;
export const EventSchemaVersionSchema = z.literal(EVENT_SCHEMA_VERSION);
export type EventSchemaVersion = z.infer<typeof EventSchemaVersionSchema>;

export const EventIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/+=-]+$/);
export type EventIdempotencyKey = z.infer<
  typeof EventIdempotencyKeySchema
>;

export const EventProducerKindSchema = z.enum([
  "control_plane",
  "runtime_kernel",
  "worker",
  "hook",
  "system",
]);
export type EventProducerKind = z.infer<typeof EventProducerKindSchema>;

export const EventProducerSchema = z
  .object({
    kind: EventProducerKindSchema,
    id: z.string().min(1).max(160).nullable(),
  })
  .strict();
export type EventProducer = z.infer<typeof EventProducerSchema>;

export const ThreadEventTypeSchema = z.enum(["thread.created"]);
export type ThreadEventType = z.infer<typeof ThreadEventTypeSchema>;

export const RunLifecycleEventTypeSchema = z.enum([
  "run.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);
export type RunLifecycleEventType = z.infer<
  typeof RunLifecycleEventTypeSchema
>;

export const TurnEventTypeSchema = z.enum([
  "turn.started",
  "turn.completed",
  "turn.failed",
]);
export type TurnEventType = z.infer<typeof TurnEventTypeSchema>;

export const AssistantTextEventTypeSchema = z.enum([
  "assistant.text.delta",
  "assistant.text.completed",
]);
export type AssistantTextEventType = z.infer<
  typeof AssistantTextEventTypeSchema
>;

export const ItemEventTypeSchema = z.enum([
  "item.started",
  "item.updated",
  "item.completed",
]);
export type ItemEventType = z.infer<typeof ItemEventTypeSchema>;

export const ToolCallEventTypeSchema = z.enum([
  "tool.call.requested",
  "tool.call.started",
  "tool.call.output.delta",
  "tool.call.completed",
  "tool.call.failed",
]);
export type ToolCallEventType = z.infer<typeof ToolCallEventTypeSchema>;

export const ApprovalEventTypeSchema = z.enum([
  "approval.requested",
  "approval.decided",
]);
export type ApprovalEventType = z.infer<typeof ApprovalEventTypeSchema>;

export const WorkspaceEventTypeSchema = z.enum([
  "workspace.preparing",
  "workspace.ready",
  "workspace.dirty",
  "workspace.failed",
  "git.status.updated",
  "git.diff.updated",
]);
export type WorkspaceEventType = z.infer<typeof WorkspaceEventTypeSchema>;

export const ArtifactEventTypeSchema = z.enum(["artifact.created"]);
export type ArtifactEventType = z.infer<typeof ArtifactEventTypeSchema>;

export const ContextEventTypeSchema = z.enum(["context.compacted"]);
export type ContextEventType = z.infer<typeof ContextEventTypeSchema>;

export const PlatformEventTypeSchema = z.enum([
  ...ThreadEventTypeSchema.options,
  ...RunLifecycleEventTypeSchema.options,
  ...TurnEventTypeSchema.options,
  ...AssistantTextEventTypeSchema.options,
  ...ItemEventTypeSchema.options,
  ...ToolCallEventTypeSchema.options,
  ...ApprovalEventTypeSchema.options,
  ...WorkspaceEventTypeSchema.options,
  ...ArtifactEventTypeSchema.options,
  ...ContextEventTypeSchema.options,
]);
export type PlatformEventType = z.infer<typeof PlatformEventTypeSchema>;

const NonEmptyMessageSchema = z.string().min(1).max(10_000);
const SafeCountSchema = z.number().int().safe().nonnegative();

export const FailurePayloadSchema = z
  .object({
    message: NonEmptyMessageSchema,
    code: z.string().min(1).max(120).nullable(),
    details: JsonRecordSchema.nullable(),
  })
  .strict();
export type FailurePayload = z.infer<typeof FailurePayloadSchema>;

export const ThreadCreatedPayloadSchema = z
  .object({
    thread: ThreadSchema,
  })
  .strict();
export type ThreadCreatedPayload = z.infer<
  typeof ThreadCreatedPayloadSchema
>;

export const RunPayloadSchema = z
  .object({
    run: RunSchema,
  })
  .strict();
export type RunPayload = z.infer<typeof RunPayloadSchema>;

export const RunFailedPayloadSchema = z
  .object({
    run: RunSchema,
    failure: FailurePayloadSchema,
  })
  .strict();
export type RunFailedPayload = z.infer<typeof RunFailedPayloadSchema>;

export const TurnPayloadSchema = z
  .object({
    turn: TurnSchema,
  })
  .strict();
export type TurnPayload = z.infer<typeof TurnPayloadSchema>;

export const TurnFailedPayloadSchema = z
  .object({
    turn: TurnSchema,
    failure: FailurePayloadSchema,
  })
  .strict();
export type TurnFailedPayload = z.infer<typeof TurnFailedPayloadSchema>;

export const AssistantTextDeltaPayloadSchema = z
  .object({
    itemId: ItemIdSchema,
    delta: z.string().min(1),
  })
  .strict();
export type AssistantTextDeltaPayload = z.infer<
  typeof AssistantTextDeltaPayloadSchema
>;

export const AssistantTextCompletedPayloadSchema = z
  .object({
    itemId: ItemIdSchema,
    text: z.string(),
  })
  .strict();
export type AssistantTextCompletedPayload = z.infer<
  typeof AssistantTextCompletedPayloadSchema
>;

export const ItemPayloadSchema = z
  .object({
    item: ThreadItemSchema,
  })
  .strict();
export type ItemPayload = z.infer<typeof ItemPayloadSchema>;

export const ToolCallRequestedPayloadSchema = z
  .object({
    itemId: ItemIdSchema,
    content: ToolCallItemContentSchema,
  })
  .strict();
export type ToolCallRequestedPayload = z.infer<
  typeof ToolCallRequestedPayloadSchema
>;

export const ToolCallPayloadSchema = z
  .object({
    itemId: ItemIdSchema,
    toolCallId: ToolCallIdSchema,
  })
  .strict();
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;

export const ToolCallOutputDeltaPayloadSchema = z
  .object({
    itemId: ItemIdSchema,
    toolCallId: ToolCallIdSchema,
    delta: z.string().min(1),
  })
  .strict();
export type ToolCallOutputDeltaPayload = z.infer<
  typeof ToolCallOutputDeltaPayloadSchema
>;

export const ToolCallCompletedPayloadSchema = z
  .object({
    itemId: ItemIdSchema,
    toolCallId: ToolCallIdSchema,
    output: JsonRecordSchema,
  })
  .strict();
export type ToolCallCompletedPayload = z.infer<
  typeof ToolCallCompletedPayloadSchema
>;

export const ToolCallFailedPayloadSchema = z
  .object({
    itemId: ItemIdSchema,
    toolCallId: ToolCallIdSchema,
    failure: FailurePayloadSchema,
  })
  .strict();
export type ToolCallFailedPayload = z.infer<
  typeof ToolCallFailedPayloadSchema
>;

export const ApprovalOptionSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(240),
    description: z.string().min(1).max(1_000).nullable(),
  })
  .strict();
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

export const ApprovalRequestedPayloadSchema = z
  .object({
    approvalId: ApprovalIdSchema,
    itemId: ItemIdSchema.nullable(),
    question: z.string().min(1).max(2_000),
    options: z.array(ApprovalOptionSchema).min(1).max(12),
    metadata: JsonRecordSchema,
  })
  .strict();
export type ApprovalRequestedPayload = z.infer<
  typeof ApprovalRequestedPayloadSchema
>;

export const ApprovalDecisionSchema = z.enum([
  "approved",
  "denied",
  "cancelled",
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalDecidedPayloadSchema = z
  .object({
    approvalId: ApprovalIdSchema,
    decision: ApprovalDecisionSchema,
    decidedBy: UserIdSchema.nullable(),
    reason: z.string().min(1).max(2_000).nullable(),
  })
  .strict();
export type ApprovalDecidedPayload = z.infer<
  typeof ApprovalDecidedPayloadSchema
>;

export const WorkspacePayloadSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
  })
  .strict();
export type WorkspacePayload = z.infer<typeof WorkspacePayloadSchema>;

export const WorkspaceFailedPayloadSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    failure: FailurePayloadSchema,
  })
  .strict();
export type WorkspaceFailedPayload = z.infer<
  typeof WorkspaceFailedPayloadSchema
>;

export const GitStatusUpdatedPayloadSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    branchName: z.string().min(1).max(240).nullable(),
    isDirty: z.boolean(),
    changedFileCount: SafeCountSchema,
  })
  .strict();
export type GitStatusUpdatedPayload = z.infer<
  typeof GitStatusUpdatedPayloadSchema
>;

export const GitDiffUpdatedPayloadSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    fileCount: SafeCountSchema,
    insertions: SafeCountSchema,
    deletions: SafeCountSchema,
  })
  .strict();
export type GitDiffUpdatedPayload = z.infer<
  typeof GitDiffUpdatedPayloadSchema
>;

export const ArtifactCreatedPayloadSchema = z
  .object({
    itemId: ItemIdSchema.nullable(),
    reference: ArtifactReferenceItemContentSchema,
  })
  .strict();
export type ArtifactCreatedPayload = z.infer<
  typeof ArtifactCreatedPayloadSchema
>;

export const ContextCompactedPayloadSchema = z
  .object({
    sourceItemIds: z.array(ItemIdSchema).min(1),
    summaryItemId: ItemIdSchema,
    tokenCountBefore: SafeCountSchema,
    tokenCountAfter: SafeCountSchema,
  })
  .strict();
export type ContextCompactedPayload = z.infer<
  typeof ContextCompactedPayloadSchema
>;

const EventEnvelopeBaseShape = {
  eventId: EventIdSchema,
  threadId: ThreadIdSchema,
  sequence: EventSequenceSchema,
  cursor: EventCursorSchema,
  idempotencyKey: EventIdempotencyKeySchema,
  createdAt: ProtocolTimestampSchema,
  producer: EventProducerSchema,
  schemaVersion: EventSchemaVersionSchema,
} as const;

function createEventSchema<
  TType extends PlatformEventType,
  TPayloadSchema extends z.ZodType<unknown>,
>(
  type: TType,
  payload: TPayloadSchema,
  runIdSchema: typeof RunIdSchema | z.ZodNullable<typeof RunIdSchema>,
) {
  return z
    .object({
      ...EventEnvelopeBaseShape,
      runId: runIdSchema,
      type: z.literal(type),
      payload,
    })
    .strict();
}

const ThreadCreatedEventSchema = createEventSchema(
  "thread.created",
  ThreadCreatedPayloadSchema,
  RunIdSchema.nullable(),
);

const RunCreatedEventSchema = createEventSchema(
  "run.created",
  RunPayloadSchema,
  RunIdSchema,
);
const RunStartedEventSchema = createEventSchema(
  "run.started",
  RunPayloadSchema,
  RunIdSchema,
);
const RunCompletedEventSchema = createEventSchema(
  "run.completed",
  RunPayloadSchema,
  RunIdSchema,
);
const RunFailedEventSchema = createEventSchema(
  "run.failed",
  RunFailedPayloadSchema,
  RunIdSchema,
);
const RunCancelledEventSchema = createEventSchema(
  "run.cancelled",
  RunPayloadSchema,
  RunIdSchema,
);

const TurnStartedEventSchema = createEventSchema(
  "turn.started",
  TurnPayloadSchema,
  RunIdSchema,
);
const TurnCompletedEventSchema = createEventSchema(
  "turn.completed",
  TurnPayloadSchema,
  RunIdSchema,
);
const TurnFailedEventSchema = createEventSchema(
  "turn.failed",
  TurnFailedPayloadSchema,
  RunIdSchema,
);

const AssistantTextDeltaEventSchema = createEventSchema(
  "assistant.text.delta",
  AssistantTextDeltaPayloadSchema,
  RunIdSchema,
);
const AssistantTextCompletedEventSchema = createEventSchema(
  "assistant.text.completed",
  AssistantTextCompletedPayloadSchema,
  RunIdSchema,
);

const ItemStartedEventSchema = createEventSchema(
  "item.started",
  ItemPayloadSchema,
  RunIdSchema,
);
const ItemUpdatedEventSchema = createEventSchema(
  "item.updated",
  ItemPayloadSchema,
  RunIdSchema,
);
const ItemCompletedEventSchema = createEventSchema(
  "item.completed",
  ItemPayloadSchema,
  RunIdSchema,
);

const ToolCallRequestedEventSchema = createEventSchema(
  "tool.call.requested",
  ToolCallRequestedPayloadSchema,
  RunIdSchema,
);
const ToolCallStartedEventSchema = createEventSchema(
  "tool.call.started",
  ToolCallPayloadSchema,
  RunIdSchema,
);
const ToolCallOutputDeltaEventSchema = createEventSchema(
  "tool.call.output.delta",
  ToolCallOutputDeltaPayloadSchema,
  RunIdSchema,
);
const ToolCallCompletedEventSchema = createEventSchema(
  "tool.call.completed",
  ToolCallCompletedPayloadSchema,
  RunIdSchema,
);
const ToolCallFailedEventSchema = createEventSchema(
  "tool.call.failed",
  ToolCallFailedPayloadSchema,
  RunIdSchema,
);

const ApprovalRequestedEventSchema = createEventSchema(
  "approval.requested",
  ApprovalRequestedPayloadSchema,
  RunIdSchema,
);
const ApprovalDecidedEventSchema = createEventSchema(
  "approval.decided",
  ApprovalDecidedPayloadSchema,
  RunIdSchema,
);

const WorkspacePreparingEventSchema = createEventSchema(
  "workspace.preparing",
  WorkspacePayloadSchema,
  RunIdSchema,
);
const WorkspaceReadyEventSchema = createEventSchema(
  "workspace.ready",
  WorkspacePayloadSchema,
  RunIdSchema,
);
const WorkspaceDirtyEventSchema = createEventSchema(
  "workspace.dirty",
  WorkspacePayloadSchema,
  RunIdSchema,
);
const WorkspaceFailedEventSchema = createEventSchema(
  "workspace.failed",
  WorkspaceFailedPayloadSchema,
  RunIdSchema,
);
const GitStatusUpdatedEventSchema = createEventSchema(
  "git.status.updated",
  GitStatusUpdatedPayloadSchema,
  RunIdSchema,
);
const GitDiffUpdatedEventSchema = createEventSchema(
  "git.diff.updated",
  GitDiffUpdatedPayloadSchema,
  RunIdSchema,
);

const ArtifactCreatedEventSchema = createEventSchema(
  "artifact.created",
  ArtifactCreatedPayloadSchema,
  RunIdSchema,
);

const ContextCompactedEventSchema = createEventSchema(
  "context.compacted",
  ContextCompactedPayloadSchema,
  RunIdSchema,
);

const RunEventSchemas = [
  RunCreatedEventSchema,
  RunStartedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  TurnStartedEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
  AssistantTextDeltaEventSchema,
  AssistantTextCompletedEventSchema,
  ItemStartedEventSchema,
  ItemUpdatedEventSchema,
  ItemCompletedEventSchema,
  ToolCallRequestedEventSchema,
  ToolCallStartedEventSchema,
  ToolCallOutputDeltaEventSchema,
  ToolCallCompletedEventSchema,
  ToolCallFailedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalDecidedEventSchema,
  WorkspacePreparingEventSchema,
  WorkspaceReadyEventSchema,
  WorkspaceDirtyEventSchema,
  WorkspaceFailedEventSchema,
  GitStatusUpdatedEventSchema,
  GitDiffUpdatedEventSchema,
  ArtifactCreatedEventSchema,
  ContextCompactedEventSchema,
] as const;

const RawThreadEventSchema = z.discriminatedUnion("type", [
  ThreadCreatedEventSchema,
]);
const RawRunEventSchema = z.discriminatedUnion("type", RunEventSchemas);
const RawPlatformEventSchema = z.discriminatedUnion("type", [
  ThreadCreatedEventSchema,
  ...RunEventSchemas,
]);
type RawPlatformEvent = z.infer<typeof RawPlatformEventSchema>;
type RunProjectionEvent = Extract<
  RawPlatformEvent,
  { type: `run.${string}` }
>;
type TurnProjectionEvent = Extract<
  RawPlatformEvent,
  { type: `turn.${string}` }
>;
type ItemProjectionEvent = Extract<
  RawPlatformEvent,
  { type: `item.${string}` }
>;

function addIdentityMismatch(
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message,
  });
}

function validateEventIdentity(
  event: RawPlatformEvent,
  context: z.RefinementCtx,
): void {
  if (event.type === "thread.created") {
    if (event.threadId !== event.payload.thread.id) {
      addIdentityMismatch(
        context,
        ["payload", "thread", "id"],
        "Thread payload ID must match the event thread ID",
      );
    }
    return;
  }

  if (isRunProjectionEvent(event)) {
    validateRunIdentity(event, context);
    return;
  }

  if (isTurnProjectionEvent(event)) {
    validateTurnIdentity(event, context);
    return;
  }

  if (isItemProjectionEvent(event)) {
    validateItemIdentity(event, context);
  }
}

function isRunProjectionEvent(
  event: RawPlatformEvent,
): event is RunProjectionEvent {
  return (
    event.type === "run.created" ||
    event.type === "run.started" ||
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  );
}

function isTurnProjectionEvent(
  event: RawPlatformEvent,
): event is TurnProjectionEvent {
  return (
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.failed"
  );
}

function isItemProjectionEvent(
  event: RawPlatformEvent,
): event is ItemProjectionEvent {
  return (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  );
}

function validateRunIdentity(
  event: RunProjectionEvent,
  context: z.RefinementCtx,
): void {
  if (event.runId !== event.payload.run.id) {
    addIdentityMismatch(
      context,
      ["payload", "run", "id"],
      "Run payload ID must match the event run ID",
    );
  }
  if (event.threadId !== event.payload.run.threadId) {
    addIdentityMismatch(
      context,
      ["payload", "run", "threadId"],
      "Run payload thread ID must match the event thread ID",
    );
  }
}

function validateTurnIdentity(
  event: TurnProjectionEvent,
  context: z.RefinementCtx,
): void {
  if (event.runId !== event.payload.turn.runId) {
    addIdentityMismatch(
      context,
      ["payload", "turn", "runId"],
      "Turn payload run ID must match the event run ID",
    );
  }
  if (event.threadId !== event.payload.turn.threadId) {
    addIdentityMismatch(
      context,
      ["payload", "turn", "threadId"],
      "Turn payload thread ID must match the event thread ID",
    );
  }
}

function validateItemIdentity(
  event: ItemProjectionEvent,
  context: z.RefinementCtx,
): void {
  if (event.runId !== event.payload.item.runId) {
    addIdentityMismatch(
      context,
      ["payload", "item", "runId"],
      "Item payload run ID must match the event run ID",
    );
  }
  if (event.threadId !== event.payload.item.threadId) {
    addIdentityMismatch(
      context,
      ["payload", "item", "threadId"],
      "Item payload thread ID must match the event thread ID",
    );
  }
}

export const ThreadEventSchema =
  RawThreadEventSchema.superRefine(validateEventIdentity);
export type ThreadEvent = z.infer<typeof ThreadEventSchema>;

export const RunEventSchema =
  RawRunEventSchema.superRefine(validateEventIdentity);
export type RunEvent = z.infer<typeof RunEventSchema>;

export const WorkspaceEventSchema = z.discriminatedUnion("type", [
  WorkspacePreparingEventSchema,
  WorkspaceReadyEventSchema,
  WorkspaceDirtyEventSchema,
  WorkspaceFailedEventSchema,
  GitStatusUpdatedEventSchema,
  GitDiffUpdatedEventSchema,
]);
export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>;

export const ArtifactEventSchema = z.discriminatedUnion("type", [
  ArtifactCreatedEventSchema,
]);
export type ArtifactEvent = z.infer<typeof ArtifactEventSchema>;

export const ApprovalEventSchema = z.discriminatedUnion("type", [
  ApprovalRequestedEventSchema,
  ApprovalDecidedEventSchema,
]);
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

export const PlatformEventSchema =
  RawPlatformEventSchema.superRefine(validateEventIdentity);
export type PlatformEvent = z.infer<typeof PlatformEventSchema>;
