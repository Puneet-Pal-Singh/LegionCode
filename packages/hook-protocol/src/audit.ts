import {
  EventIdSchema,
  EventSequenceSchema,
  JsonRecordSchema,
  ProtocolTimestampSchema,
  RunIdSchema,
  ThreadIdSchema,
} from "@repo/platform-protocol";
import { z } from "zod";
import { HookEventNameSchema } from "./events.js";
import { HookOutcomeSchemaByEventName } from "./outcomes.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export const HookInvocationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "timed_out",
  "failed",
  "skipped",
]);
export type HookInvocationStatus = z.infer<typeof HookInvocationStatusSchema>;

export const HookInvocationIdSchema = z
  .string()
  .regex(
    /^hki_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/,
    "HookInvocationId must use hki_ prefix and an opaque suffix",
  );
export type HookInvocationId = z.infer<typeof HookInvocationIdSchema>;

export const HookHandlerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.:-]{0,127}$/);
export type HookHandlerId = z.infer<typeof HookHandlerIdSchema>;

export const HookInvocationSchema = z
  .object({
    invocationId: HookInvocationIdSchema,
    eventId: EventIdSchema,
    runId: RunIdSchema,
    sessionId: ThreadIdSchema,
    threadId: ThreadIdSchema,
    handlerId: HookHandlerIdSchema,
    eventName: HookEventNameSchema,
    startedAt: ProtocolTimestampSchema,
    completedAt: ProtocolTimestampSchema.nullable(),
    status: HookInvocationStatusSchema,
    inputHash: z.string().regex(SHA256_HEX_PATTERN),
    outputHash: z.string().regex(SHA256_HEX_PATTERN).nullable(),
    errorCode: z.string().min(1).max(128).nullable(),
    errorMessage: z.string().min(1).max(2_000).nullable(),
  })
  .strict();
export type HookInvocation = z.infer<typeof HookInvocationSchema>;

export const HookAuditEventTypeSchema = z.enum([
  "hook.invocation.started",
  "hook.invocation.completed",
  "hook.invocation.failed",
  "hook.invocation.timed_out",
  "hook.outcome.applied",
]);
export type HookAuditEventType = z.infer<typeof HookAuditEventTypeSchema>;

export const HookInvocationAuditEventSchema = z
  .object({
    auditEventId: EventIdSchema,
    eventType: HookAuditEventTypeSchema,
    invocation: HookInvocationSchema,
    outcome: z
      .union([
        HookOutcomeSchemaByEventName.SessionStart,
        HookOutcomeSchemaByEventName.UserPromptSubmit,
        HookOutcomeSchemaByEventName.PermissionRequest,
        HookOutcomeSchemaByEventName.Stop,
      ])
      .nullable(),
    metadata: JsonRecordSchema,
    emittedAt: ProtocolTimestampSchema,
    eventSequence: EventSequenceSchema,
  })
  .strict();
export type HookInvocationAuditEvent = z.infer<
  typeof HookInvocationAuditEventSchema
>;
