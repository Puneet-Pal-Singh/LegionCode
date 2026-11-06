import { z } from "zod";
import {
  HarnessStartCommandSchema,
  HarnessSessionSchema,
  HarnessControlCommandSchema,
  HarnessObservationSchema,
  HarnessCommitAckSchema,
  HarnessQuiescenceSchema,
  type HarnessSession,
  type HarnessStartCommand,
} from "@repo/worker-protocol";

// Transport envelopes only. All domain values use the canonical private schemas.
const id = z.string().uuid();
const request = { type: z.literal("request"), requestId: id };
export const CloudHarnessRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...request,
      operation: z.literal("open"),
      command: HarnessStartCommandSchema,
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
export type CloudHarnessRequest = z.infer<typeof CloudHarnessRequestSchema>;
const result = { type: z.literal("result"), requestId: id };
export const CloudHarnessResultSchema = z.discriminatedUnion("operation", [
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
export const CloudHarnessObservationFrameSchema = z
  .object({
    type: z.literal("observation"),
    deliveryId: id,
    observation: HarnessObservationSchema,
  })
  .strict();
export const CloudHarnessAckFrameSchema = z
  .object({
    type: z.literal("ack"),
    deliveryId: id,
    ack: HarnessCommitAckSchema,
  })
  .strict();
export const CloudHarnessErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    requestId: id,
    code: z.enum(["unavailable", "invalid_request", "recovery_required"]),
  })
  .strict();
export const CloudHarnessWorkerFrameSchema = z.union([
  CloudHarnessRequestSchema,
  CloudHarnessAckFrameSchema,
]);
export const CloudHarnessHostFrameSchema = z.union([
  CloudHarnessResultSchema,
  CloudHarnessObservationFrameSchema,
  CloudHarnessErrorFrameSchema,
]);
export type CloudHarnessHostFrame = z.infer<typeof CloudHarnessHostFrameSchema>;

/** Separate immutable admission from learned external session/process identity. */
export type CloudHarnessTarget =
  | { readonly command: HarnessStartCommand }
  | { readonly session: HarnessSession };

export function sameCloudHarnessSession(
  a: HarnessSession,
  b: HarnessSession,
): boolean {
  return (
    a.runAttemptId === b.runAttemptId &&
    a.instanceId === b.instanceId &&
    a.externalSessionId === b.externalSessionId &&
    a.processGeneration === b.processGeneration
  );
}
