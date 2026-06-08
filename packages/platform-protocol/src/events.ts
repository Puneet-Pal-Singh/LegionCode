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
  ArtifactIdSchema,
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
  "sdk",
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
    artifactId: ArtifactIdSchema,
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

export const ThreadCreatedEventSchema = createEventSchema(
  "thread.created",
  ThreadCreatedPayloadSchema,
  RunIdSchema.nullable(),
);

export const RunCreatedEventSchema = createEventSchema(
  "run.created",
  RunPayloadSchema,
  RunIdSchema,
);
export const RunStartedEventSchema = createEventSchema(
  "run.started",
  RunPayloadSchema,
  RunIdSchema,
);
export const RunCompletedEventSchema = createEventSchema(
  "run.completed",
  RunPayloadSchema,
  RunIdSchema,
);
export const RunFailedEventSchema = createEventSchema(
  "run.failed",
  RunFailedPayloadSchema,
  RunIdSchema,
);
export const RunCancelledEventSchema = createEventSchema(
  "run.cancelled",
  RunPayloadSchema,
  RunIdSchema,
);

export const TurnStartedEventSchema = createEventSchema(
  "turn.started",
  TurnPayloadSchema,
  RunIdSchema,
);
export const TurnCompletedEventSchema = createEventSchema(
  "turn.completed",
  TurnPayloadSchema,
  RunIdSchema,
);
export const TurnFailedEventSchema = createEventSchema(
  "turn.failed",
  TurnFailedPayloadSchema,
  RunIdSchema,
);

export const AssistantTextDeltaEventSchema = createEventSchema(
  "assistant.text.delta",
  AssistantTextDeltaPayloadSchema,
  RunIdSchema,
);
export const AssistantTextCompletedEventSchema = createEventSchema(
  "assistant.text.completed",
  AssistantTextCompletedPayloadSchema,
  RunIdSchema,
);

export const ItemStartedEventSchema = createEventSchema(
  "item.started",
  ItemPayloadSchema,
  RunIdSchema,
);
export const ItemUpdatedEventSchema = createEventSchema(
  "item.updated",
  ItemPayloadSchema,
  RunIdSchema,
);
export const ItemCompletedEventSchema = createEventSchema(
  "item.completed",
  ItemPayloadSchema,
  RunIdSchema,
);

export const ToolCallRequestedEventSchema = createEventSchema(
  "tool.call.requested",
  ToolCallRequestedPayloadSchema,
  RunIdSchema,
);
export const ToolCallStartedEventSchema = createEventSchema(
  "tool.call.started",
  ToolCallPayloadSchema,
  RunIdSchema,
);
export const ToolCallOutputDeltaEventSchema = createEventSchema(
  "tool.call.output.delta",
  ToolCallOutputDeltaPayloadSchema,
  RunIdSchema,
);
export const ToolCallCompletedEventSchema = createEventSchema(
  "tool.call.completed",
  ToolCallCompletedPayloadSchema,
  RunIdSchema,
);
export const ToolCallFailedEventSchema = createEventSchema(
  "tool.call.failed",
  ToolCallFailedPayloadSchema,
  RunIdSchema,
);

export const ApprovalRequestedEventSchema = createEventSchema(
  "approval.requested",
  ApprovalRequestedPayloadSchema,
  RunIdSchema,
);
export const ApprovalDecidedEventSchema = createEventSchema(
  "approval.decided",
  ApprovalDecidedPayloadSchema,
  RunIdSchema,
);

export const WorkspacePreparingEventSchema = createEventSchema(
  "workspace.preparing",
  WorkspacePayloadSchema,
  RunIdSchema,
);
export const WorkspaceReadyEventSchema = createEventSchema(
  "workspace.ready",
  WorkspacePayloadSchema,
  RunIdSchema,
);
export const WorkspaceDirtyEventSchema = createEventSchema(
  "workspace.dirty",
  WorkspacePayloadSchema,
  RunIdSchema,
);
export const WorkspaceFailedEventSchema = createEventSchema(
  "workspace.failed",
  WorkspaceFailedPayloadSchema,
  RunIdSchema,
);
export const GitStatusUpdatedEventSchema = createEventSchema(
  "git.status.updated",
  GitStatusUpdatedPayloadSchema,
  RunIdSchema,
);
export const GitDiffUpdatedEventSchema = createEventSchema(
  "git.diff.updated",
  GitDiffUpdatedPayloadSchema,
  RunIdSchema,
);

export const ArtifactCreatedEventSchema = createEventSchema(
  "artifact.created",
  ArtifactCreatedPayloadSchema,
  RunIdSchema,
);

export const ContextCompactedEventSchema = createEventSchema(
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

export const ThreadEventSchema = z.discriminatedUnion("type", [
  ThreadCreatedEventSchema,
]);
export type ThreadEvent = z.infer<typeof ThreadEventSchema>;

export const RunEventSchema = z.discriminatedUnion("type", RunEventSchemas);
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

export const PlatformEventSchema = z.discriminatedUnion("type", [
  ThreadCreatedEventSchema,
  ...RunEventSchemas,
]);
export type PlatformEvent = z.infer<typeof PlatformEventSchema>;
