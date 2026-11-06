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

export type CloudHarnessCleanupOperation =
  | "interrupt"
  | "dispose"
  | "quiescence"
  | "cleanup_connect";
export type CloudHarnessActiveOperation =
  | "open"
  | "execute"
  | "observe"
  | "steer"
  | "reply"
  | "user_input_reply"
  | "observation"
  | "commit_ack"
  | "connect"
  | "bootstrap";
export type CloudHarnessActiveTarget = (
  | { readonly command: HarnessStartCommand }
  | { readonly session: HarnessSession }
) & { readonly operation: CloudHarnessActiveOperation };
export type CloudHarnessCleanupTarget = {
  readonly session: HarnessSession;
  readonly operation: CloudHarnessCleanupOperation;
};
export type CloudHarnessTarget =
  | CloudHarnessActiveTarget
  | CloudHarnessCleanupTarget;
export function isCloudHarnessCleanup(
  target: CloudHarnessTarget,
): target is CloudHarnessCleanupTarget {
  return ["interrupt", "dispose", "quiescence", "cleanup_connect"].includes(
    target.operation,
  );
}
export function cloudHarnessRequestTarget(
  request: CloudHarnessRequest,
): CloudHarnessTarget {
  switch (request.operation) {
    case "open":
    case "execute":
      return { operation: request.operation, command: request.command };
    case "observe":
      return { operation: "observe", session: request.session };
    case "quiescence":
      return { operation: "quiescence", session: request.session };
    case "control": {
      const session =
        request.command.kind === "reply" ||
        request.command.kind === "user_input_reply"
          ? request.command.reply.replyTo.session
          : request.command.session;
      if (
        request.command.kind === "interrupt" ||
        request.command.kind === "dispose"
      )
        return { operation: request.command.kind, session };
      return { operation: request.command.kind, session };
    }
  }
}

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
