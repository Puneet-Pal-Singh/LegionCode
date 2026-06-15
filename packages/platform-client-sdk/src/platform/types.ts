import { z } from "zod";
import {
  ApprovalDecisionSchema,
  ApprovalIdSchema,
  ArtifactMetadataSchema,
  EventCursorSchema,
  JsonRecordSchema,
  ModelIdSchema,
  PermissionProfileIdSchema,
  ProviderIdSchema,
  RunIdSchema,
  RunModeSchema,
  ThreadIdSchema,
  ThreadSchema,
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
const MAX_LIST_LIMIT = 200;
export const StreamRetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    delayMs: z.number().int().min(0).max(30_000),
  })
  .strict();
export type StreamRetryPolicy = z.infer<typeof StreamRetryPolicySchema>;

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

export const ListThreadsRequestSchema = z
  .object({
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    afterCursor: EventCursorSchema.nullable().optional(),
    limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
  })
  .strict();
export type ListThreadsRequest = z.infer<typeof ListThreadsRequestSchema>;

export const ListThreadsResponseSchema = z
  .object({
    threads: z.array(ThreadSchema),
    nextCursor: EventCursorSchema.nullable(),
  })
  .strict();
export type ListThreadsResponse = z.infer<typeof ListThreadsResponseSchema>;

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

export const ListArtifactsRequestSchema = z
  .object({
    runId: RunIdSchema,
    afterCursor: EventCursorSchema.nullable().optional(),
    limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
  })
  .strict();
export type ListArtifactsRequest = z.infer<typeof ListArtifactsRequestSchema>;

export const ListArtifactsResponseSchema = z
  .object({
    artifacts: z.array(ArtifactMetadataSchema),
    nextCursor: EventCursorSchema.nullable(),
  })
  .strict();
export type ListArtifactsResponse = z.infer<typeof ListArtifactsResponseSchema>;

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
  streamRetry?: StreamRetryPolicy;
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
  getThread(
    threadId: Thread["id"],
    options?: PlatformClientOperationOptions,
  ): Promise<unknown>;
  listThreads(
    request: ListThreadsRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<unknown>;
  getRun(
    runId: Run["id"],
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
  listArtifacts(
    request: ListArtifactsRequest,
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
  getThread(
    threadId: Thread["id"],
    options?: PlatformClientOperationOptions,
  ): Promise<Thread>;
  listThreads(
    request: ListThreadsRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<ListThreadsResponse>;
  getRun(
    runId: Run["id"],
    options?: PlatformClientOperationOptions,
  ): Promise<Run>;
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
  listArtifacts(
    request: ListArtifactsRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<ListArtifactsResponse>;
  getWorkspaceManifest(
    runId: Run["id"],
    options?: PlatformClientOperationOptions,
  ): Promise<WorkspaceManifest>;
}

export type PlatformClientUserId = UserId;
