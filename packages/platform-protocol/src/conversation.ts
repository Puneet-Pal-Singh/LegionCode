import { z } from "zod";
import {
  BranchIdSchema,
  EventSequenceSchema,
  JsonRecordSchema,
  ProtocolTimestampSchema,
} from "./common.js";
import {
  ArtifactIdSchema,
  ItemIdSchema,
  ModelIdSchema,
  PermissionProfileIdSchema,
  ProviderIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkerIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";

export const ThreadStatusSchema = z.enum(["active", "archived"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ThreadTitleSourceSchema = z.enum([
  "user",
  "generated",
  "imported",
  "none",
]);
export type ThreadTitleSource = z.infer<typeof ThreadTitleSourceSchema>;

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunModeSchema = z.enum([
  "ask",
  "auto_edit",
  "review",
  "plan",
]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const TurnStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const ThreadItemTypeSchema = z.enum([
  "user_message",
  "assistant_message",
  "reasoning_summary",
  "tool_call",
  "tool_result",
  "approval_request",
  "approval_decision",
  "file_change",
  "git_operation",
  "artifact_reference",
  "context_compaction",
  "system_marker",
]);
export type ThreadItemType = z.infer<typeof ThreadItemTypeSchema>;

const GenericThreadItemTypeSchema = z.enum([
  "user_message",
  "assistant_message",
  "reasoning_summary",
  "tool_result",
  "approval_request",
  "approval_decision",
  "file_change",
  "git_operation",
  "context_compaction",
  "system_marker",
]);

export const ThreadItemRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
  "runtime",
]);
export type ThreadItemRole = z.infer<typeof ThreadItemRoleSchema>;

export const ThreadItemStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type ThreadItemStatus = z.infer<typeof ThreadItemStatusSchema>;

export const ThreadSchema = z
  .object({
    id: ThreadIdSchema,
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    title: z.string().min(1).max(300),
    titleSource: ThreadTitleSourceSchema,
    status: ThreadStatusSchema,
    pinnedAt: ProtocolTimestampSchema.nullable(),
    archivedAt: ProtocolTimestampSchema.nullable(),
    activeRunId: RunIdSchema.nullable(),
    activeLeafItemId: ItemIdSchema.nullable(),
    createdAt: ProtocolTimestampSchema,
    updatedAt: ProtocolTimestampSchema,
    lastEventSequence: EventSequenceSchema,
  })
  .strict();
export type Thread = z.infer<typeof ThreadSchema>;

export const RunSchema = z
  .object({
    id: RunIdSchema,
    threadId: ThreadIdSchema,
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    status: RunStatusSchema,
    mode: RunModeSchema,
    providerId: ProviderIdSchema,
    modelId: ModelIdSchema,
    workerId: WorkerIdSchema,
    permissionProfileId: PermissionProfileIdSchema,
    startedAt: ProtocolTimestampSchema.nullable(),
    completedAt: ProtocolTimestampSchema.nullable(),
    createdAt: ProtocolTimestampSchema,
    updatedAt: ProtocolTimestampSchema,
    lastEventSequence: EventSequenceSchema,
  })
  .strict();
export type Run = z.infer<typeof RunSchema>;

export const TurnSchema = z
  .object({
    id: TurnIdSchema,
    threadId: ThreadIdSchema,
    runId: RunIdSchema,
    parentTurnId: TurnIdSchema.nullable(),
    status: TurnStatusSchema,
    startedAt: ProtocolTimestampSchema.nullable(),
    completedAt: ProtocolTimestampSchema.nullable(),
    createdAt: ProtocolTimestampSchema,
    updatedAt: ProtocolTimestampSchema,
    lastEventSequence: EventSequenceSchema,
  })
  .strict();
export type Turn = z.infer<typeof TurnSchema>;

export const ToolCallItemContentSchema = z
  .object({
    toolCallId: ToolCallIdSchema,
    toolName: z.string().min(1).max(160),
    input: JsonRecordSchema,
  })
  .strict();
export type ToolCallItemContent = z.infer<
  typeof ToolCallItemContentSchema
>;

export const ArtifactReferenceItemContentSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    label: z.string().min(1).max(240),
    metadata: JsonRecordSchema,
  })
  .strict();
export type ArtifactReferenceItemContent = z.infer<
  typeof ArtifactReferenceItemContentSchema
>;

const ThreadItemBaseShape = {
  id: ItemIdSchema,
  threadId: ThreadIdSchema,
  runId: RunIdSchema.nullable(),
  turnId: TurnIdSchema.nullable(),
  parentItemId: ItemIdSchema.nullable(),
  branchId: BranchIdSchema.nullable(),
  role: ThreadItemRoleSchema,
  status: ThreadItemStatusSchema,
  createdAt: ProtocolTimestampSchema,
  completedAt: ProtocolTimestampSchema.nullable(),
  eventSequence: EventSequenceSchema,
} as const;

const GenericThreadItemSchema = z
  .object({
    ...ThreadItemBaseShape,
    type: GenericThreadItemTypeSchema,
    content: JsonRecordSchema,
  })
  .strict();

const ToolCallThreadItemSchema = z
  .object({
    ...ThreadItemBaseShape,
    type: z.literal("tool_call"),
    content: ToolCallItemContentSchema,
  })
  .strict();

const ArtifactReferenceThreadItemSchema = z
  .object({
    ...ThreadItemBaseShape,
    type: z.literal("artifact_reference"),
    content: ArtifactReferenceItemContentSchema,
  })
  .strict();

export const ThreadItemSchema = z.discriminatedUnion("type", [
  GenericThreadItemSchema,
  ToolCallThreadItemSchema,
  ArtifactReferenceThreadItemSchema,
]);
export type ThreadItem = z.infer<typeof ThreadItemSchema>;

export const RunItemSchema = ThreadItemSchema.and(z.object({
  runId: RunIdSchema,
  turnId: TurnIdSchema,
}));
export type RunItem = z.infer<typeof RunItemSchema>;
