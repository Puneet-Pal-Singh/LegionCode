import { z } from "zod";
import {
  ApprovalDecisionSchema,
  ApprovalIdSchema,
  EventSequenceSchema,
  JsonRecordSchema,
  LifecycleEventSchema,
  ModelIdSchema,
  PermissionProfileIdSchema,
  ProviderIdSchema,
  RunModeSchema,
  RunSchema,
  ThreadIdSchema,
  TurnDiffPayloadSchema,
  TurnIdSchema,
  TurnSchema,
  UserIdSchema,
  WorkerIdSchema,
  WorkspaceIdSchema,
  type EventSequence,
  type LifecycleEvent,
  type Run,
  type Turn,
  type TurnDiffPayload,
} from "@repo/platform-protocol";

const MAX_LIFECYCLE_REPLAY_LIMIT = 1_000;

export const StartTurnRequestSchema = z
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
export type StartTurnRequest = z.infer<typeof StartTurnRequestSchema>;

export const StartTurnResponseSchema = z
  .object({
    run: RunSchema,
    turn: TurnSchema,
  })
  .strict();
export interface StartTurnResponse {
  readonly run: Run;
  readonly turn: Turn;
}

export const ReplayLifecycleEventsRequestSchema = z
  .object({
    turnId: TurnIdSchema,
    afterSequence: EventSequenceSchema.nullable().optional(),
    limit: z.number().int().min(1).max(MAX_LIFECYCLE_REPLAY_LIMIT).optional(),
  })
  .strict();
export type ReplayLifecycleEventsRequest = z.infer<
  typeof ReplayLifecycleEventsRequestSchema
>;

export const ReplayLifecycleEventsResponseSchema = z
  .object({
    events: z.array(LifecycleEventSchema),
    nextSequence: EventSequenceSchema.nullable(),
  })
  .strict();
export interface ReplayLifecycleEventsResponse {
  readonly events: readonly LifecycleEvent[];
  readonly nextSequence: EventSequence | null;
}

export const AttachLifecycleStreamRequestSchema = z
  .object({
    turnId: TurnIdSchema,
    afterSequence: EventSequenceSchema.nullable().optional(),
  })
  .strict();
export type AttachLifecycleStreamRequest = z.infer<
  typeof AttachLifecycleStreamRequestSchema
>;

export const FollowLifecycleRequestSchema =
  ReplayLifecycleEventsRequestSchema.omit({ limit: true })
    .extend({
      replayLimit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIFECYCLE_REPLAY_LIMIT)
        .optional(),
    })
    .strict();
export type FollowLifecycleRequest = z.infer<
  typeof FollowLifecycleRequestSchema
>;

export const SubmitLifecycleApprovalRequestSchema = z
  .object({
    turnId: TurnIdSchema,
    approvalId: ApprovalIdSchema,
    decision: ApprovalDecisionSchema,
    decidedBy: UserIdSchema.nullable(),
    reason: z.string().min(1).max(2_000).nullable(),
  })
  .strict();
export type SubmitLifecycleApprovalRequest = z.infer<
  typeof SubmitLifecycleApprovalRequestSchema
>;

export const SubmitUserInputResponseRequestSchema = z
  .object({
    turnId: TurnIdSchema,
    requestId: z.string().min(1).max(160),
    respondedBy: UserIdSchema.nullable(),
    response: JsonRecordSchema,
  })
  .strict();
export type SubmitUserInputResponseRequest = z.infer<
  typeof SubmitUserInputResponseRequestSchema
>;

export const GetTurnDiffRequestSchema = z
  .object({
    turnId: TurnIdSchema,
  })
  .strict();
export type GetTurnDiffRequest = z.infer<typeof GetTurnDiffRequestSchema>;

export const GetTurnDiffResponseSchema = z
  .object({
    diff: TurnDiffPayloadSchema.nullable(),
  })
  .strict();
export interface GetTurnDiffResponse {
  readonly diff: TurnDiffPayload | null;
}
