import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApprovalIdSchema } from "@repo/platform-protocol";
import type {
  HarnessObservationPayload,
  HarnessReply,
  HarnessRequestOrigin,
  HarnessSession,
} from "@repo/worker-protocol";
import type { CodexServerRequest } from "./transport/CodexStdioTransport.js";
import { codexItemId, nativeIdentity } from "./CodexEventMapper.js";

/** Only one-time command/file decisions; no session grants, exec-policy or network amendments. */
export function codexPermission(
  raw: CodexServerRequest,
  session: HarnessSession,
  authOwnerGeneration: number,
  externalTurnId: string,
): {
  payload: Extract<HarnessObservationPayload, { kind: "approval_requested" }>;
  reply: (decision: HarnessReply) => void;
} {
  if (
    ![
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(raw.method)
  )
    throw new Error("Unsupported Codex request");
  const p = nativeIdentity
    .extend({
      itemId: z.string().min(1),
      grantRoot: z.string().nullish(),
      command: z.string().max(65536).nullish(),
      cwd: z.string().max(4096).nullish(),
      kind: z.enum(["command", "humanCommand", "writeStdin"]).optional(),
      networkApprovalContext: z.unknown().optional(),
    })
    .parse(raw.params);
  if (
    p.threadId !== session.externalSessionId ||
    p.turnId !== externalTurnId ||
    p.grantRoot != null ||
    (raw.method === "item/commandExecution/requestApproval" &&
      ((p.kind !== undefined && p.kind !== "command") ||
        p.networkApprovalContext != null))
  )
    throw new Error("Invalid Codex request origin or scope");
  const origin: HarnessRequestOrigin = {
    session,
    origin: "codex-app-server-stdio",
    requestId: `${typeof raw.id}:${raw.id}`,
    authOwnerGeneration,
  };
  const payload: Extract<
    HarnessObservationPayload,
    { kind: "approval_requested" }
  > = {
    kind: "approval_requested",
    parentItemId: codexItemId(session.runAttemptId, p.itemId),
    request: {
      approvalId: ApprovalIdSchema.parse(`appr_${randomUUID()}`),
      itemId: codexItemId(session.runAttemptId, `approval:${origin.requestId}`),
      question: raw.method.includes("commandExecution")
        ? "Allow this Codex command once?"
        : "Allow this Codex file change once?",
      options: [
        { id: "approved", label: "Allow once", description: null },
        { id: "denied", label: "Deny", description: null },
        { id: "cancelled", label: "Cancel", description: null },
      ],
      metadata: {
        source: "harness_reported",
        nativeRequest: raw.method,
        command: p.command ?? null,
        cwd: p.cwd ?? null,
      },
    },
    replyTo: origin,
  };
  let used = false;
  return {
    payload,
    reply: (reply) => {
      if (
        used ||
        JSON.stringify(reply.replyTo) !== JSON.stringify(origin) ||
        reply.grantScope !== undefined
      )
        throw new Error("Codex reply unavailable");
      used = true;
      raw.reply({
        decision:
          reply.decision === "approved"
            ? "accept"
            : reply.decision === "denied"
              ? "decline"
              : "cancel",
      });
    },
  };
}
