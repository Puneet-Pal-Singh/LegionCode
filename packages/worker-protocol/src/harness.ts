import {
  UserInputRequestSchema,
  UserInputResponseSchema,
} from "@repo/platform-protocol";
import { z } from "zod";
import {
  ApprovalDecisionSchema,
  ApprovalGrantScopeSchema,
  ApprovalRequestedPayloadSchema,
  HarnessSelectionSchema,
  HarnessAdmissionSelectionSchema,
  ProductModeSchema,
  PermissionProfileIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  HarnessActivityMeasuredPayloadSchema,
  HarnessProviderLimitNotifiedPayloadSchema,
  JsonRecordSchema,
  ItemIdSchema,
  LeaseIdSchema,
  ProtocolErrorSchema,
  ProtocolTimestampSchema,
  RunAttemptIdSchema,
  ToolCallItemContentSchema,
  UsageCostSnapshotSchema,
  TurnWorkspaceSnapshotSchema,
  TurnInputAcceptedPayloadSchema,
  TurnInputAppliedPayloadSchema,
  EventSequenceSchema,
} from "@repo/platform-protocol";

const OpaqueId = z.string().min(1).max(256);
const Generation = z.number().int().safe().nonnegative();
/** Learned session identity; never overwrites the admitted selection. */
export const HarnessSessionSchema = z
  .object({
    runAttemptId: RunAttemptIdSchema,
    instanceId: OpaqueId,
    externalSessionId: OpaqueId,
    processGeneration: z.string().uuid(),
  })
  .strict()
  .readonly();
export type HarnessSession = z.infer<typeof HarnessSessionSchema>;
export const HarnessRequestOriginSchema = z
  .object({
    session: HarnessSessionSchema,
    origin: OpaqueId,
    requestId: OpaqueId,
    authOwnerGeneration: Generation,
  })
  .strict()
  .readonly();
export type HarnessRequestOrigin = z.infer<typeof HarnessRequestOriginSchema>;

/** Foreground completion alone is never proof that descendants stopped mutating. */
export const HarnessQuiescenceSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("quiescent"),
      session: HarnessSessionSchema,
      observedAt: ProtocolTimestampSchema,
      evidenceId: OpaqueId,
      scope: z.literal("process_tree_and_background_work"),
      observationIntegrity: z.enum(["complete", "lost"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      session: HarnessSessionSchema,
      reason: z.enum([
        "timeout",
        "transport_lost",
        "unsupported",
        "work_still_running",
        "observation_integrity_lost",
      ]),
    })
    .strict(),
]);
export type HarnessQuiescence = z.infer<typeof HarnessQuiescenceSchema>;

export const HarnessObservationPayloadSchema = z.discriminatedUnion("kind", [
  HarnessActivityMeasuredPayloadSchema.extend({
    kind: z.literal("activity_measurement"),
    background: z.literal(true).optional(),
  }).strict(),
  HarnessProviderLimitNotifiedPayloadSchema.extend({
    kind: z.literal("provider_limit"),
    background: z.literal(true).optional(),
  }).strict(),
  z
    .object({
      kind: z.literal("thread_input_applied"),
      background: z.literal(true).optional(),
      input: TurnInputAppliedPayloadSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("assistant_text"),
      background: z.literal(true).optional(),
      itemId: ItemIdSchema,
      text: z.string().max(1_048_576),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_started"),
      background: z.literal(true).optional(),
      itemId: ItemIdSchema,
      content: ToolCallItemContentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_completed"),
      background: z.literal(true).optional(),
      itemId: ItemIdSchema,
      output: z.string().max(1_048_576),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_failed"),
      background: z.literal(true).optional(),
      itemId: ItemIdSchema,
      failure: ProtocolErrorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("user_input_requested"),
      background: z.literal(true).optional(),
      itemId: ItemIdSchema,
      requestId: z.string().min(1).max(160),
      payload: UserInputRequestSchema,
      replyTo: HarnessRequestOriginSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("request_withdrawn"),
      background: z.literal(true).optional(),
      requestType: z.enum(["approval", "user_input"]),
      itemId: ItemIdSchema,
      requestId: z.string().min(1).max(160),
      replyTo: HarnessRequestOriginSchema,
      reason: z.enum(["native_rejected", "native_cancelled"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval_requested"),
      background: z.literal(true).optional(),
      parentItemId: ItemIdSchema,
      request: ApprovalRequestedPayloadSchema,
      replyTo: HarnessRequestOriginSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("usage"),
      background: z.literal(true).optional(),
      usage: UsageCostSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_terminal"),
      status: z.enum(["completed", "failed", "interrupted"]),
      providerCompletedAt: ProtocolTimestampSchema.nullable(),
      itemId: ItemIdSchema,
      output: z.string().max(1_048_576),
      error: ProtocolErrorSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("quiescence"),
      evidence: HarnessQuiescenceSchema,
    })
    .strict(),
]);
export const HarnessObservationSchema = z
  .object({
    session: HarnessSessionSchema,
    sequence: z.number().int().safe().positive(),
    externalTurnId: OpaqueId.nullable(),
    payload: HarnessObservationPayloadSchema,
  })
  .strict()
  .readonly();
export type HarnessObservation = z.infer<typeof HarnessObservationSchema>;
export type HarnessObservationPayload = z.infer<
  typeof HarnessObservationPayloadSchema
>;
export const HarnessCommitAckSchema = z
  .object({
    session: HarnessSessionSchema,
    committedSequence: z.number().int().safe().positive(),
  })
  .strict()
  .readonly();
export type HarnessCommitAck = z.infer<typeof HarnessCommitAckSchema>;

export const HarnessReplySchema = z
  .object({
    replyTo: HarnessRequestOriginSchema,
    decision: ApprovalDecisionSchema,
    grantScope: ApprovalGrantScopeSchema.optional(),
  })
  .strict()
  .readonly();
export type HarnessReply = z.infer<typeof HarnessReplySchema>;

export const HarnessStartCommandSchema = z
  .object({
    mode: z.enum(["start", "recover_same_attempt"]),
    commandId: OpaqueId,
    selection: HarnessSelectionSchema,
    leaseId: LeaseIdSchema,
    startSnapshot: TurnWorkspaceSnapshotSchema,
    filesystemRoot: z.string().min(1).max(4096),
    prompt: z.string().min(1).max(1_048_576),
    resumeSession: HarnessSessionSchema.nullable(),
  })
  .strict()
  .readonly();
export type HarnessStartCommand = z.infer<typeof HarnessStartCommandSchema>;
export const HarnessUserInputReplySchema = z
  .object({
    replyTo: HarnessRequestOriginSchema,
    response: UserInputResponseSchema,
  })
  .strict()
  .readonly();
export type HarnessUserInputReply = z.infer<typeof HarnessUserInputReplySchema>;

export const HarnessControlCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user_input_reply"),
      commandId: OpaqueId,
      reply: HarnessUserInputReplySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("steer"),
      commandId: OpaqueId,
      session: HarnessSessionSchema,
      expectedExternalTurnId: OpaqueId,
      accepted: TurnInputAcceptedPayloadSchema.extend({
        acceptedSequence: EventSequenceSchema,
      }),
      text: z.string().min(1).max(1_048_576),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interrupt"),
      commandId: OpaqueId,
      session: HarnessSessionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reply"),
      commandId: OpaqueId,
      reply: HarnessReplySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("dispose"),
      commandId: OpaqueId,
      session: HarnessSessionSchema,
    })
    .strict(),
]);
export type HarnessControlCommand = z.infer<typeof HarnessControlCommandSchema>;

/** Private Brain -> SECURE_API service binding. Internal service authentication is
 * mandatory on both routes; bridge additionally requires the existing lease token.
 * No provider credentials are carried by this protocol. */
export const HARNESS_SERVICE_CAPABILITY_PATH = "/api/v1/harness/capability";
export const HARNESS_SERVICE_BRIDGE_PATH = "/api/v1/harness/bridge";
export const HarnessServiceScopeSchema = z
  .object({
    userId: OpaqueId,
    workspaceId: OpaqueId,
    sessionId: OpaqueId,
    runId: OpaqueId,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    runAttemptId: RunAttemptIdSchema,
  })
  .strict();
export const HarnessServiceCapabilityRequestSchema = z
  .object({
    scope: HarnessServiceScopeSchema,
    capture: HarnessAdmissionSelectionSchema,
    productMode: ProductModeSchema,
  })
  .strict();
export const HarnessServiceCapabilitySchema = z.discriminatedUnion(
  "available",
  [
    z.object({ available: z.literal(false), code: OpaqueId }).strict(),
    z
      .object({
        available: z.literal(true),
        productModes: z.array(ProductModeSchema).min(1),
        policyId: PermissionProfileIdSchema,
        policyRevision: OpaqueId,
      })
      .strict(),
  ],
);
export type HarnessServiceScope = z.infer<typeof HarnessServiceScopeSchema>;
export type HarnessServiceCapability = z.infer<
  typeof HarnessServiceCapabilitySchema
>;
export const HarnessServiceConnectSchema = z
  .object({
    type: z.literal("connect"),
    scope: HarnessServiceScopeSchema,
    lease: z
      .object({
        leaseId: LeaseIdSchema,
        generation: Generation,
        sandboxId: OpaqueId,
      })
      .strict(),
  })
  .strict();
const id = z.string().uuid();
const request = { type: z.literal("request"), requestId: id };
/** Private turn-opening coordination. These receipts never certify OS confinement. */
export const HarnessOpeningCloudLeaseSchema = z
  .object({
    kind: z.literal("cloud"),
    leaseId: LeaseIdSchema,
    sandboxId: OpaqueId,
    generation: Generation,
  })
  .strict();
export const HarnessOpeningLocalLeaseSchema = z
  .object({ kind: z.literal("local"), leaseId: LeaseIdSchema })
  .strict();
export const HarnessOpeningIntentSchema = z
  .object({
    openingRef: OpaqueId,
    commandId: OpaqueId,
    commandFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    runAttemptId: RunAttemptIdSchema,
    instanceId: OpaqueId,
    processGeneration: z.string().uuid(),
    authOwnerGeneration: Generation,
    workspaceGrantId: OpaqueId,
    checkoutLeaseId: LeaseIdSchema,
    startSnapshotId: OpaqueId,
    executionLease: z.discriminatedUnion("kind", [
      HarnessOpeningCloudLeaseSchema,
      HarnessOpeningLocalLeaseSchema,
    ]),
  })
  .strict();
export type HarnessOpeningIntent = z.infer<typeof HarnessOpeningIntentSchema>;
export const HarnessOpeningCommitSchema = z
  .object({
    openingRef: OpaqueId,
    commandFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    processGeneration: z.string().uuid(),
    phase: z.enum(["reserved", "dispatching", "acknowledged"]),
  })
  .strict();
export type HarnessOpeningCommit = z.infer<typeof HarnessOpeningCommitSchema>;
export const HarnessOpeningClaimFrameSchema = z
  .object({
    type: z.literal("opening_claim"),
    deliveryId: id,
    operation: z.enum(["reserve", "begin_dispatch"]),
    intent: HarnessOpeningIntentSchema,
  })
  .strict();
export const HarnessOpeningSessionFrameSchema = z
  .object({
    type: z.literal("opening_session"),
    deliveryId: id,
    intent: HarnessOpeningIntentSchema,
    session: HarnessSessionSchema,
  })
  .strict();
export const HarnessOpeningCommitFrameSchema = z
  .object({
    type: z.literal("opening_commit"),
    deliveryId: id,
    commit: HarnessOpeningCommitSchema,
  })
  .strict();
export async function fingerprintHarnessCommand(
  raw: HarnessStartCommand,
): Promise<string> {
  const command = HarnessStartCommandSchema.parse(raw);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(command)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export const HarnessOpeningFenceTargetSchema = z
  .object({
    userId: OpaqueId,
    workspaceId: OpaqueId,
    environmentId: OpaqueId,
    turnId: TurnIdSchema,
    runAttemptId: RunAttemptIdSchema,
    instanceId: OpaqueId,
    openingRef: OpaqueId,
    commandFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    processGeneration: z.string().uuid(),
    executionLease: HarnessOpeningIntentSchema.shape.executionLease,
  })
  .strict();
export type HarnessOpeningFenceTarget = z.infer<
  typeof HarnessOpeningFenceTargetSchema
>;
export const HarnessOpeningFenceResultSchema = z
  .object({
    status: z.literal("unknown"),
    processGeneration: z.string().uuid(),
    reason: z.enum(["owner_unavailable", "scope_proof_unavailable"]),
  })
  .strict();
export type HarnessOpeningFenceResult = z.infer<
  typeof HarnessOpeningFenceResultSchema
>;
export const HarnessServiceRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...request,
      operation: z.literal("opening_fence"),
      target: HarnessOpeningFenceTargetSchema,
      timeoutMs: z.number().int().min(1).max(60000),
    })
    .strict(),
  z
    .object({
      ...request,
      operation: z.literal("open"),
      command: HarnessStartCommandSchema,
      executionLease: HarnessOpeningCloudLeaseSchema,
    })
    .strict(),
  z
    .object({
      ...request,
      operation: z.literal("execute"),
      command: HarnessStartCommandSchema,
      session: HarnessSessionSchema,
    })
    .strict(),
  z
    .object({
      ...request,
      operation: z.literal("observe"),
      session: HarnessSessionSchema,
    })
    .strict(),
  z
    .object({
      ...request,
      operation: z.literal("control"),
      command: HarnessControlCommandSchema,
    })
    .strict(),
  z
    .object({
      ...request,
      operation: z.literal("quiescence"),
      session: HarnessSessionSchema,
      timeoutMs: z.number().int().min(1).max(60_000),
    })
    .strict(),
]);
export type HarnessServiceRequest = z.infer<typeof HarnessServiceRequestSchema>;
const result = { type: z.literal("result"), requestId: id };
export const HarnessServiceResultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...result,
      operation: z.literal("opening_fence"),
      value: HarnessOpeningFenceResultSchema,
    })
    .strict(),
  z
    .object({
      ...result,
      operation: z.literal("open"),
      value: HarnessSessionSchema,
    })
    .strict(),
  z
    .object({ ...result, operation: z.literal("execute"), value: z.null() })
    .strict(),
  z
    .object({ ...result, operation: z.literal("observe"), value: z.null() })
    .strict(),
  z
    .object({
      ...result,
      operation: z.literal("control"),
      value: z.object({ accepted: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      ...result,
      operation: z.literal("quiescence"),
      value: HarnessQuiescenceSchema,
    })
    .strict(),
]);
export const HarnessServiceObservationFrameSchema = z
  .object({
    type: z.literal("observation"),
    deliveryId: id,
    observation: HarnessObservationSchema,
  })
  .strict();
export const HarnessServiceAckFrameSchema = z
  .object({
    type: z.literal("ack"),
    deliveryId: id,
    ack: HarnessCommitAckSchema,
  })
  .strict();
export const HarnessServiceErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    requestId: id,
    code: z.enum(["unavailable", "invalid_request", "recovery_required"]),
  })
  .strict();
export const HarnessServiceWorkerFrameSchema = z.union([
  HarnessServiceConnectSchema,
  HarnessServiceRequestSchema,
  HarnessServiceAckFrameSchema,
  HarnessOpeningCommitFrameSchema,
]);
export const HarnessServiceHostFrameSchema = z.union([
  z.object({ type: z.literal("connected") }).strict(),
  HarnessServiceResultSchema,
  HarnessServiceObservationFrameSchema,
  HarnessOpeningClaimFrameSchema,
  HarnessOpeningSessionFrameSchema,
  HarnessServiceErrorFrameSchema,
]);
export type HarnessServiceHostFrame = z.infer<
  typeof HarnessServiceHostFrameSchema
>;

export type HarnessServiceResult = z.infer<typeof HarnessServiceResultSchema>;
