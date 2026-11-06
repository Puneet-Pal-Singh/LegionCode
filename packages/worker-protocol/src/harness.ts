import { z } from "zod";
import {
  ApprovalDecisionSchema, ApprovalGrantScopeSchema, ApprovalRequestedPayloadSchema,
  HarnessSelectionSchema, ItemIdSchema, LeaseIdSchema, ProtocolErrorSchema,
  ProtocolTimestampSchema, RunAttemptIdSchema, ToolCallItemContentSchema,
  UsageCostSnapshotSchema, WorkspaceSnapshotIdSchema,
} from "@repo/platform-protocol";

const OpaqueId = z.string().min(1).max(256);
const Generation = z.number().int().safe().nonnegative();
/** Learned session identity; never overwrites the admitted selection. */
export const HarnessSessionSchema = z.object({
  runAttemptId: RunAttemptIdSchema,
  instanceId: OpaqueId,
  externalSessionId: OpaqueId,
  processGeneration: Generation,
}).strict().readonly();
export type HarnessSession = z.infer<typeof HarnessSessionSchema>;
export const HarnessRequestOriginSchema = z.object({
  session: HarnessSessionSchema,
  origin: OpaqueId,
  requestId: OpaqueId,
  authOwnerGeneration: Generation,
}).strict().readonly();
export type HarnessRequestOrigin = z.infer<typeof HarnessRequestOriginSchema>;

/** Foreground completion alone is never proof that descendants stopped mutating. */
export const HarnessQuiescenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("quiescent"), session: HarnessSessionSchema,
    observedAt: ProtocolTimestampSchema, evidenceId: OpaqueId,
    scope: z.literal("process_tree_and_background_work") }).strict(),
  z.object({ status: z.literal("unknown"), session: HarnessSessionSchema,
    reason: z.enum(["timeout", "transport_lost", "unsupported", "work_still_running"]) }).strict(),
]);
export type HarnessQuiescence = z.infer<typeof HarnessQuiescenceSchema>;

export const HarnessObservationPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assistant_text"), itemId: ItemIdSchema,
    text: z.string().max(1_048_576) }).strict(),
  z.object({ kind: z.literal("tool_started"), itemId: ItemIdSchema,
    content: ToolCallItemContentSchema }).strict(),
  z.object({ kind: z.literal("tool_completed"), itemId: ItemIdSchema,
    output: z.string().max(1_048_576) }).strict(),
  z.object({ kind: z.literal("approval_requested"), parentItemId: ItemIdSchema,
    request: ApprovalRequestedPayloadSchema, replyTo: HarnessRequestOriginSchema }).strict(),
  z.object({ kind: z.literal("usage"), usage: UsageCostSnapshotSchema }).strict(),
  z.object({ kind: z.literal("external_terminal"),
    status: z.enum(["completed", "failed", "interrupted"]),
    itemId: ItemIdSchema, output: z.string().max(1_048_576),
    error: ProtocolErrorSchema.nullable() }).strict(),
  z.object({ kind: z.literal("quiescence"), evidence: HarnessQuiescenceSchema }).strict(),
]);
export const HarnessObservationSchema = z.object({
  session: HarnessSessionSchema,
  sequence: z.number().int().safe().positive(),
  externalTurnId: OpaqueId.nullable(),
  payload: HarnessObservationPayloadSchema,
}).strict().readonly();
export type HarnessObservation = z.infer<typeof HarnessObservationSchema>;
export type HarnessObservationPayload = z.infer<typeof HarnessObservationPayloadSchema>;
export const HarnessCommitAckSchema = z.object({
  session: HarnessSessionSchema,
  committedSequence: z.number().int().safe().positive(),
}).strict().readonly();
export type HarnessCommitAck = z.infer<typeof HarnessCommitAckSchema>;

export const HarnessReplySchema = z.object({
  replyTo: HarnessRequestOriginSchema,
  decision: ApprovalDecisionSchema,
  grantScope: ApprovalGrantScopeSchema.optional(),
}).strict().readonly();
export type HarnessReply = z.infer<typeof HarnessReplySchema>;

export const HarnessStartCommandSchema = z.object({
  commandId: OpaqueId,
  selection: HarnessSelectionSchema,
  leaseId: LeaseIdSchema,
  startSnapshotId: WorkspaceSnapshotIdSchema,
  filesystemRoot: z.string().min(1).max(4096),
  prompt: z.string().min(1).max(1_048_576),
  resumeSession: HarnessSessionSchema.nullable(),
}).strict().readonly();
export type HarnessStartCommand = z.infer<typeof HarnessStartCommandSchema>;
export const HarnessControlCommandSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("steer"), commandId: OpaqueId, session: HarnessSessionSchema,
    expectedExternalTurnId: OpaqueId, text: z.string().min(1).max(1_048_576)}).strict(),
  z.object({kind: z.literal("interrupt"), commandId: OpaqueId, session: HarnessSessionSchema}).strict(),
  z.object({kind: z.literal("reply"), commandId: OpaqueId, reply: HarnessReplySchema}).strict(),
  z.object({kind: z.literal("dispose"), commandId: OpaqueId, session: HarnessSessionSchema}).strict(),
]);
export type HarnessControlCommand = z.infer<typeof HarnessControlCommandSchema>;
