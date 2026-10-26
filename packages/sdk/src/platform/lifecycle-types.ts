import { z } from "zod";
import {
  InterruptTurnRequestSchema,
  LifecycleEventSchema,
  JsonRecordSchema,
  ModelIdSchema,
  PermissionProfileIdSchema,
  ProviderIdSchema,
  RunModeSchema,
  RunSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  TurnSchema,
  UserIdSchema,
  WorkerIdSchema,
  WorkspaceIdSchema,
  CompactTurnRequestSchema,
  CompactTurnResponseSchema,
  type CompactTurnRequest,
  type CompactTurnResponse,
  type Run,
  type Turn,
} from "@repo/platform-protocol";
import {
  FollowLifecycleRequestSchema,
  GetTurnDiffRequestSchema,
  GetTurnDiffResponseSchema,
  ReplayLifecycleEventsRequestSchema,
  ReplayLifecycleEventsResponseSchema,
  SubmitLifecycleApprovalRequestSchema,
  type FollowLifecycleRequest,
  type GetTurnDiffRequest,
  type GetTurnDiffResponse,
  type ReplayLifecycleEventsRequest,
  type ReplayLifecycleEventsResponse,
  type SubmitLifecycleApprovalRequest,
} from "@repo/platform-protocol";

export {
  FollowLifecycleRequestSchema,
  GetTurnDiffRequestSchema,
  GetTurnDiffResponseSchema,
  ReplayLifecycleEventsRequestSchema,
  ReplayLifecycleEventsResponseSchema,
  SubmitLifecycleApprovalRequestSchema,
  type FollowLifecycleRequest,
  type GetTurnDiffRequest,
  type GetTurnDiffResponse,
  type ReplayLifecycleEventsRequest,
  type ReplayLifecycleEventsResponse,
  type SubmitLifecycleApprovalRequest,
};

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

export { CompactTurnRequestSchema, CompactTurnResponseSchema };
export type { CompactTurnRequest, CompactTurnResponse };

import {
  InterruptTurnIdentitySchema,
  type InterruptTurnIdentity,
} from "@repo/platform-protocol";

export { InterruptTurnIdentitySchema, type InterruptTurnIdentity };

export { InterruptTurnRequestSchema };
export type { InterruptTurnRequest } from "@repo/platform-protocol";

export const InterruptTurnResponseSchema = z.object({
  runId: RunIdSchema,
  accepted: z.boolean(),
  status: z.enum(["interrupt_requested", "settled"]).nullable(),
  terminalEvent: LifecycleEventSchema.nullable().optional(),
}).strict();
export type InterruptTurnResponse = z.infer<typeof InterruptTurnResponseSchema>;
