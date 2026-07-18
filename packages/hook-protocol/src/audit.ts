import {
  EventIdSchema,
  EventSequenceSchema,
  ProtocolTimestampSchema,
  RunIdSchema,
  ThreadIdSchema,
} from "@repo/platform-protocol";
import { z } from "zod";
import {
  HookHandlerIdSchema,
  HookSourceSchema,
} from "./definitions.js";
import { HookEventNameSchema } from "./events.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export const HookInvocationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "timed_out",
  "failed",
  "skipped",
  "cancelled",
]);
export type HookInvocationStatus = z.infer<typeof HookInvocationStatusSchema>;

export const HookInvocationIdSchema = z
  .string()
  .regex(
    /^hki_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/,
    "HookInvocationId must use hki_ prefix and an opaque suffix",
  );
export type HookInvocationId = z.infer<typeof HookInvocationIdSchema>;

export const HookInvocationSchema = z
  .object({
    invocationId: HookInvocationIdSchema,
    eventId: EventIdSchema,
    runId: RunIdSchema,
    threadId: ThreadIdSchema,
    handlerId: HookHandlerIdSchema,
    source: HookSourceSchema,
    order: z.number().int().min(0).max(10_000),
    eventName: HookEventNameSchema,
    startedAt: ProtocolTimestampSchema,
    completedAt: ProtocolTimestampSchema.nullable(),
    status: HookInvocationStatusSchema,
    inputHash: z.string().regex(SHA256_HEX_PATTERN),
    outputHash: z.string().regex(SHA256_HEX_PATTERN).nullable(),
    errorCode: z.string().min(1).max(128).nullable(),
    errorMessage: z.string().min(1).max(2_000).nullable(),
  })
  .strict()
  .superRefine((invocation, context) => {
    const isActive =
      invocation.status === "queued" || invocation.status === "running";
    if (isActive !== (invocation.completedAt === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "Only active hook invocations omit completion time.",
      });
    }
    if (
      invocation.status === "completed" &&
      (invocation.outputHash === null ||
        invocation.errorCode !== null ||
        invocation.errorMessage !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Completed hook invocations require output and no error.",
      });
    }
    if (
      ["failed", "timed_out", "cancelled"].includes(invocation.status) &&
      (invocation.errorCode === null || invocation.errorMessage === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "Unsuccessful hook invocations require a safe typed error.",
      });
    }
  });
export type HookInvocation = z.infer<typeof HookInvocationSchema>;

export const HookAuditEventTypeSchema = z.enum([
  "hook.invocation.started",
  "hook.invocation.completed",
  "hook.invocation.failed",
  "hook.invocation.timed_out",
  "hook.invocation.cancelled",
  "hook.outcome.applied",
]);
export type HookAuditEventType = z.infer<typeof HookAuditEventTypeSchema>;

const HookOutcomeSummaryBaseSchema = z.object({
  addedContextCount: z.number().int().min(0).max(64),
  hasUserVisibleMessage: z.boolean(),
});

export const HookOutcomeSummarySchema = z.discriminatedUnion("eventName", [
  HookOutcomeSummaryBaseSchema.extend({
    eventName: z.literal("SessionStart"),
    status: z.enum(["continue", "stop"]),
    cleanupStatus: z.null(),
  }).strict(),
  HookOutcomeSummaryBaseSchema.extend({
    eventName: z.literal("UserPromptSubmit"),
    status: z.enum(["continue", "block"]),
    cleanupStatus: z.null(),
  }).strict(),
  HookOutcomeSummaryBaseSchema.extend({
    eventName: z.literal("PermissionRequest"),
    status: z.enum(["approve", "deny", "ask"]),
    cleanupStatus: z.null(),
  }).strict(),
  HookOutcomeSummaryBaseSchema.extend({
    eventName: z.literal("Stop"),
    status: z.literal("continue"),
    cleanupStatus: z.enum(["completed", "failed", "skipped"]).nullable(),
  }).strict(),
]);
export type HookOutcomeSummary = z.infer<typeof HookOutcomeSummarySchema>;

export const HookAuditMetadataSchema = z
  .object({
    durationMs: z.number().int().min(0).nullable(),
    cleanupStatus: z.enum(["completed", "failed", "skipped"]).nullable(),
  })
  .strict();
export type HookAuditMetadata = z.infer<typeof HookAuditMetadataSchema>;

const HookAuditShape = {
  eventType: HookAuditEventTypeSchema,
  invocation: HookInvocationSchema,
  outcomeSummary: HookOutcomeSummarySchema.nullable(),
  metadata: HookAuditMetadataSchema,
  emittedAt: ProtocolTimestampSchema,
} as const;

export const HookAuditAppendInputSchema = z
  .object(HookAuditShape)
  .strict()
  .superRefine(validateHookAuditShape);
export type HookAuditAppendInput = z.infer<
  typeof HookAuditAppendInputSchema
>;

const HookInvocationLifecycleEventTypeSchema =
  HookAuditEventTypeSchema.exclude(["hook.outcome.applied"]);

/**
 * Safe lifecycle payloads are observational invocation audits only. Applying a
 * hook outcome remains a separate policy decision and can never be smuggled
 * through the runtime event stream.
 */
export const HookInvocationLifecycleAuditSchema =
  HookAuditAppendInputSchema.and(
    z
      .object({
        eventType: HookInvocationLifecycleEventTypeSchema,
      })
      .passthrough(),
  );
export type HookInvocationLifecycleAudit = z.infer<
  typeof HookInvocationLifecycleAuditSchema
>;

export const HookInvocationAuditEventSchema = z
  .object({
    auditEventId: EventIdSchema,
    ...HookAuditShape,
    eventSequence: EventSequenceSchema,
  })
  .strict()
  .superRefine(validateHookAuditShape);
export type HookInvocationAuditEvent = z.infer<
  typeof HookInvocationAuditEventSchema
>;

function validateHookAuditShape(
  event: {
    eventType: HookAuditEventType;
    invocation: HookInvocation;
    outcomeSummary: HookOutcomeSummary | null;
  },
  context: z.RefinementCtx,
): void {
  if (
    event.outcomeSummary !== null &&
    event.outcomeSummary.eventName !== event.invocation.eventName
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcomeSummary", "eventName"],
      message: "Hook outcome summary must match its invocation event.",
    });
  }
  const expectedStatus = {
    "hook.invocation.started": "running",
    "hook.invocation.completed": "completed",
    "hook.invocation.failed": "failed",
    "hook.invocation.timed_out": "timed_out",
    "hook.invocation.cancelled": "cancelled",
    "hook.outcome.applied": "completed",
  } as const;
  if (event.invocation.status !== expectedStatus[event.eventType]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["invocation", "status"],
      message: "Hook audit event type must match invocation status.",
    });
  }
  const requiresSummary =
    event.eventType === "hook.invocation.completed" ||
    event.eventType === "hook.outcome.applied";
  if (requiresSummary !== (event.outcomeSummary !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcomeSummary"],
      message:
        "Only completed or applied hook audit events contain outcome summaries.",
    });
  }
}
