import { z } from "zod";
import { TurnDiffPayloadSchema, type TurnDiffPayload } from "./artifacts.js";
import { EventSequenceSchema, type EventSequence } from "./common.js";
import { ApprovalDecisionSchema } from "./events.js";
import { LifecycleEventSchema, LifecycleOperationBackendSchema, type LifecycleEvent } from "./lifecycle.js";
import { ApprovalIdSchema, EventIdSchema, TurnIdSchema, UserIdSchema } from "./ids.js";

const MAX_LIFECYCLE_REPLAY_LIMIT = 1_000;

export const LIFECYCLE_EVENT_BYTE_READ_REQUIRED = "lifecycle_event_byte_read_required";
export const LIFECYCLE_EVENT_CHUNK_MAX_BYTES = 256 * 1024;

/** A transport reference to the exact immutable canonical event, never a
 * replacement lifecycle event or an advanceable replay cursor. */
export const LifecycleEventBytesReferenceSchema = z.object({
  formatVersion: z.literal(1),
  turnId: TurnIdSchema,
  eventId: EventIdSchema,
  sequence: EventSequenceSchema,
  byteLength: z.number().int().safe().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type LifecycleEventBytesReference = z.infer<typeof LifecycleEventBytesReferenceSchema>;

export const LifecycleEventBytesRequiredMetadataSchema = z.object({
  reference: LifecycleEventBytesReferenceSchema,
}).strict();
export type LifecycleEventBytesRequiredMetadata = z.infer<typeof LifecycleEventBytesRequiredMetadataSchema>;

export const ReadLifecycleEventChunkRequestSchema = z.object({
  turnId: TurnIdSchema,
  eventId: EventIdSchema,
  sequence: EventSequenceSchema,
  sha256: LifecycleEventBytesReferenceSchema.shape.sha256,
  offset: z.number().int().safe().nonnegative(),
  limit: z.number().int().min(1).max(LIFECYCLE_EVENT_CHUNK_MAX_BYTES).optional(),
  backend: LifecycleOperationBackendSchema.optional(),
}).strict();
export type ReadLifecycleEventChunkRequest = z.infer<typeof ReadLifecycleEventChunkRequestSchema>;

export const ReadLifecycleEventChunkResponseSchema = z.object({
  reference: LifecycleEventBytesReferenceSchema,
  offset: z.number().int().safe().nonnegative(),
  byteLength: z.number().int().min(1).max(LIFECYCLE_EVENT_CHUNK_MAX_BYTES),
  dataBase64: z.string().min(4)
    .max(4 * Math.ceil(LIFECYCLE_EVENT_CHUNK_MAX_BYTES / 3))
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  nextOffset: z.number().int().safe().positive().nullable(),
}).strict().refine((chunk) => {
  const padding = chunk.dataBase64.endsWith("==") ? 2 : chunk.dataBase64.endsWith("=") ? 1 : 0;
  const end = chunk.offset + chunk.byteLength;
  return chunk.dataBase64.length * 3 / 4 - padding === chunk.byteLength &&
    chunk.offset <= chunk.reference.byteLength - chunk.byteLength &&
    chunk.nextOffset === (end < chunk.reference.byteLength ? end : null);
}, "Lifecycle event chunk must preserve its exact byte range and immutable reference");
export type ReadLifecycleEventChunkResponse = z.infer<typeof ReadLifecycleEventChunkResponseSchema>;

export const ReplayLifecycleEventsRequestSchema = z.object({
  turnId: TurnIdSchema,
  afterSequence: EventSequenceSchema.nullable().optional(),
  limit: z.number().int().min(1).max(MAX_LIFECYCLE_REPLAY_LIMIT).optional(),
  backend: LifecycleOperationBackendSchema.optional(),
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

export const FollowLifecycleRequestSchema = ReplayLifecycleEventsRequestSchema.omit({ limit: true, backend: true })
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
  backend: LifecycleOperationBackendSchema.optional(),
}).strict();
export type SubmitLifecycleApprovalRequest = z.infer<typeof SubmitLifecycleApprovalRequestSchema>;

export const GetTurnDiffRequestSchema = z.object({ turnId: TurnIdSchema, backend: LifecycleOperationBackendSchema.optional() }).strict();
export type GetTurnDiffRequest = z.infer<typeof GetTurnDiffRequestSchema>;

export const GetTurnDiffResponseSchema = z.object({
  diff: TurnDiffPayloadSchema.nullable(),
}).strict();
export interface GetTurnDiffResponse {
  readonly diff: TurnDiffPayload | null;
}
