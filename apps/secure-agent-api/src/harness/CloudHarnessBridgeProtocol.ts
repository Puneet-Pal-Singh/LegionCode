import { z } from "zod";
import {
  HarnessServiceRequestSchema,
  HarnessServiceResultSchema,
  HarnessServiceObservationFrameSchema,
  HarnessServiceAckFrameSchema,
  HarnessServiceErrorFrameSchema,
  type HarnessSession,
  type HarnessStartCommand,
  type HarnessServiceRequest,
} from "@repo/worker-protocol";
// One canonical private service/bridge schema family. The Node-private peer has
// no service-binding connect/connected frame; those belong to the Worker hop.
export const CloudHarnessRequestSchema = HarnessServiceRequestSchema;
export type CloudHarnessRequest = HarnessServiceRequest;
export const CloudHarnessResultSchema = HarnessServiceResultSchema;
export const CloudHarnessObservationFrameSchema =
  HarnessServiceObservationFrameSchema;
export const CloudHarnessAckFrameSchema = HarnessServiceAckFrameSchema;
export const CloudHarnessErrorFrameSchema = HarnessServiceErrorFrameSchema;
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
