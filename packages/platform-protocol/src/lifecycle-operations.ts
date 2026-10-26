import { z } from "zod";
import { TurnDiffPayloadSchema, type TurnDiffPayload } from "./artifacts.js";
import { EventSequenceSchema, type EventSequence } from "./common.js";
import { ApprovalDecisionSchema } from "./events.js";
import { LifecycleEventSchema, type LifecycleEvent } from "./lifecycle.js";
import { ApprovalIdSchema, TurnIdSchema, UserIdSchema } from "./ids.js";

const MAX_LIFECYCLE_REPLAY_LIMIT = 1_000;

export const ReplayLifecycleEventsRequestSchema = z.object({
  turnId: TurnIdSchema,
  afterSequence: EventSequenceSchema.nullable().optional(),
  limit: z.number().int().min(1).max(MAX_LIFECYCLE_REPLAY_LIMIT).optional(),
}).strict();
export type ReplayLifecycleEventsRequest = z.infer<typeof ReplayLifecycleEventsRequestSchema>;

export const ReplayLifecycleEventsResponseSchema = z.object({
  events: z.array(LifecycleEventSchema),
  nextSequence: EventSequenceSchema.nullable(),
}).strict();
export interface ReplayLifecycleEventsResponse {
  readonly events: readonly LifecycleEvent[];
  readonly nextSequence: EventSequence | null;
}

export const FollowLifecycleRequestSchema = ReplayLifecycleEventsRequestSchema.omit({ limit: true })
  .extend({ replayLimit: z.number().int().min(1).max(MAX_LIFECYCLE_REPLAY_LIMIT).optional() })
  .strict();
export type FollowLifecycleRequest = z.infer<typeof FollowLifecycleRequestSchema>;

export const SubmitLifecycleApprovalRequestSchema = z.object({
  turnId: TurnIdSchema,
  approvalId: ApprovalIdSchema,
  decision: ApprovalDecisionSchema,
  grantScope: z.enum(["once", "matching_in_chat"]).optional(),
  decidedBy: UserIdSchema.nullable(),
  reason: z.string().min(1).max(2_000).nullable(),
}).strict();
export type SubmitLifecycleApprovalRequest = z.infer<typeof SubmitLifecycleApprovalRequestSchema>;

export const GetTurnDiffRequestSchema = z.object({ turnId: TurnIdSchema }).strict();
export type GetTurnDiffRequest = z.infer<typeof GetTurnDiffRequestSchema>;

export const GetTurnDiffResponseSchema = z.object({
  diff: TurnDiffPayloadSchema.nullable(),
}).strict();
export interface GetTurnDiffResponse {
  readonly diff: TurnDiffPayload | null;
}
