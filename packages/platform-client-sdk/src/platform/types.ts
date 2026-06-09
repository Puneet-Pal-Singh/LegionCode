import { z } from "zod";
import {
  ApprovalDecisionSchema,
  ApprovalEventTypeSchema,
  AssistantTextEventTypeSchema,
  ContextEventTypeSchema,
  ApprovalIdSchema,
  EventCursorSchema,
  EventIdempotencyKeySchema,
  EventProducerSchema,
  EventSchemaVersionSchema,
  ItemEventTypeSchema,
  JsonRecordSchema,
  ModelIdSchema,
  PermissionProfileIdSchema,
  ProviderIdSchema,
  RunIdSchema,
  RunLifecycleEventTypeSchema,
  RunModeSchema,
  ThreadIdSchema,
  ToolCallEventTypeSchema,
  TurnEventTypeSchema,
  UserIdSchema,
  WorkerIdSchema,
  WorkspaceIdSchema,
  type ArtifactId,
  type ArtifactMetadata,
  type EventCursor,
  type Run,
  type RunEvent,
  type Thread,
  type UserId,
  type WorkspaceManifest,
} from "@repo/platform-protocol";

const MAX_EVENT_REPLAY_LIMIT = 1_000;
const RunEventTypeSchema = z.enum([
  ...RunLifecycleEventTypeSchema.options,
  ...TurnEventTypeSchema.options,
  ...AssistantTextEventTypeSchema.options,
  ...ItemEventTypeSchema.options,
  ...ToolCallEventTypeSchema.options,
  ...ApprovalEventTypeSchema.options,
  ...ContextEventTypeSchema.options,
]);

export const CreateThreadRequestSchema = z
  .object({
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    title: z.string().min(1).max(300),
    metadata: JsonRecordSchema.optional(),
  })
  .strict();
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;

export const CreateRunRequestSchema = z
  .object({
    threadId: ThreadIdSchema,
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    mode: RunModeSchema,
    providerId: ProviderIdSchema,
    modelId: ModelIdSchema,
    workerId: WorkerIdSchema,
    permissionProfileId: PermissionProfileIdSchema,
    input: JsonRecordSchema,
  })
  .strict();
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const AppendRunEventRequestSchema = z
  .object({
    threadId: ThreadIdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    scopeType: z.literal("run"),
    scopeId: RunIdSchema,
    type: RunEventTypeSchema,
    idempotencyKey: EventIdempotencyKeySchema,
    producer: EventProducerSchema,
    schemaVersion: EventSchemaVersionSchema,
    payload: JsonRecordSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.scopeId !== request.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "Run event scopeId must match runId",
      });
    }
  });

export type AppendRunEventRequest = Omit<
  RunEvent,
  "eventId" | "sequence" | "cursor" | "createdAt"
>;

export const AttachRunStreamRequestSchema = z
  .object({
    runId: RunIdSchema,
    afterCursor: EventCursorSchema.nullable().optional(),
  })
  .strict();
export type AttachRunStreamRequest = z.infer<
  typeof AttachRunStreamRequestSchema
>;

export const ReplayRunEventsRequestSchema = z
  .object({
    runId: RunIdSchema,
    afterCursor: EventCursorSchema.nullable().optional(),
    limit: z.number().int().min(1).max(MAX_EVENT_REPLAY_LIMIT).optional(),
  })
  .strict();
export type ReplayRunEventsRequest = z.infer<
  typeof ReplayRunEventsRequestSchema
>;

export const ReplayRunEventsResponseSchema = z
  .object({
    events: z.array(z.unknown()),
    nextCursor: EventCursorSchema.nullable(),
  })
  .strict();
export interface ReplayRunEventsResponse {
  events: readonly RunEvent[];
  nextCursor: EventCursor | null;
}

export const SubmitApprovalRequestSchema = z
  .object({
    runId: RunIdSchema,
    approvalId: ApprovalIdSchema,
    decision: ApprovalDecisionSchema,
    decidedBy: UserIdSchema.nullable(),
    reason: z.string().min(1).max(2_000).nullable(),
  })
  .strict();
export type SubmitApprovalRequest = z.infer<
  typeof SubmitApprovalRequestSchema
>;

export interface PlatformClientOperationOptions {
  signal?: AbortSignal;
}

export interface PlatformClientTransport {
  createThread(
    request: CreateThreadRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<unknown>;
  createRun(
    request: CreateRunRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<unknown>;
  appendRunEvent(
    request: AppendRunEventRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<unknown>;
  attachRunStream(
    request: AttachRunStreamRequest,
    options?: PlatformClientOperationOptions,
  ): AsyncIterable<unknown>;
  replayRunEvents(
    request: ReplayRunEventsRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<unknown>;
  submitApproval(
    request: SubmitApprovalRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<unknown>;
  getArtifact(
    artifactId: ArtifactId,
    options?: PlatformClientOperationOptions,
  ): Promise<unknown>;
  getWorkspaceManifest(
    runId: Run["id"],
    options?: PlatformClientOperationOptions,
  ): Promise<unknown>;
}

export interface PlatformClient {
  createThread(
    request: CreateThreadRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<Thread>;
  createRun(
    request: CreateRunRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<Run>;
  appendRunEvent(
    request: AppendRunEventRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<RunEvent>;
  attachRunStream(
    request: AttachRunStreamRequest,
    options?: PlatformClientOperationOptions,
  ): AsyncIterable<RunEvent>;
  replayRunEvents(
    request: ReplayRunEventsRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<ReplayRunEventsResponse>;
  submitApproval(
    request: SubmitApprovalRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<RunEvent>;
  getArtifact(
    artifactId: ArtifactId,
    options?: PlatformClientOperationOptions,
  ): Promise<ArtifactMetadata>;
  getWorkspaceManifest(
    runId: Run["id"],
    options?: PlatformClientOperationOptions,
  ): Promise<WorkspaceManifest>;
}

export type PlatformClientUserId = UserId;
