import type { ToolRequestUserInputResponse } from "./protocol/generated/v2/ToolRequestUserInputResponse.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  HarnessObservationPayload,
  HarnessSession,
  HarnessUserInputReply,
} from "@repo/worker-protocol";
import type { CodexServerRequest } from "./transport/CodexStdioTransport.js";
import { codexItemId, nativeIdentity } from "./CodexEventMapper.js";

const question = z.object({
  id: z.string().min(1).max(160),
  header: z.string().max(240),
  question: z.string().min(1).max(8192),
  isOther: z.boolean(),
  isSecret: z.literal(false),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(1024),
        description: z.string().max(4096),
      }),
    )
    .max(32)
    .nullable(),
});

/** Experimental, explicitly opted-in only. Secret input has no canonical credential route here. */
export function codexQuestion(
  raw: CodexServerRequest,
  session: HarnessSession,
  authOwnerGeneration: number,
  externalTurnId: string,
): {
  payload: Extract<HarnessObservationPayload, { kind: "user_input_requested" }>;
  reply: (reply: HarnessUserInputReply) => void;
} {
  if (raw.method !== "item/tool/requestUserInput")
    throw new Error("Unsupported Codex question");
  const p = nativeIdentity
    .extend({
      itemId: z.string().min(1),
      isBlocking: z.boolean(),
      questions: z.array(question).min(1).max(8),
    })
    .parse(raw.params);
  if (
    p.threadId !== session.externalSessionId ||
    p.turnId !== externalTurnId ||
    new Set(p.questions.map((q) => q.id)).size !== p.questions.length
  )
    throw new Error("Invalid Codex question origin");
  const origin = {
    session,
    origin: "codex-app-server-stdio",
    requestId: `${typeof raw.id}:${raw.id}`,
    authOwnerGeneration,
  };
  const requestId = `codex-input-${createHash("sha256").update(JSON.stringify(origin)).digest("hex")}`;
  let used = false;
  return {
    payload: {
      kind: "user_input_requested",
      itemId: codexItemId(session.runAttemptId, p.itemId),
      requestId,
      payload: {
        questions: p.questions,
        isBlocking: p.isBlocking,
        experimental: true,
      },
      replyTo: origin,
    },
    reply: (input) => {
      if (used || JSON.stringify(input.replyTo) !== JSON.stringify(origin))
        throw new Error("Codex question reply unavailable");
      const result: ToolRequestUserInputResponse = z
        .object({
          answers: z.record(
            z
              .object({ answers: z.array(z.string().max(8192)).min(1).max(32) })
              .strict(),
          ),
        })
        .strict()
        .parse(input.response);
      const keys = Object.keys(result.answers);
      if (
        keys.length !== p.questions.length ||
        keys.some((key) => !p.questions.some((q) => q.id === key))
      )
        throw new Error("Codex question answer identity mismatch");
      for (const q of p.questions) {
        const answers = result.answers[q.id]?.answers;
        if (
          !answers ||
          (!q.isOther &&
            q.options &&
            answers.some(
              (answer) => !q.options!.some((option) => option.label === answer),
            ))
        )
          throw new Error("Invalid Codex question answer");
      }
      used = true;
      raw.reply(result);
    },
  };
}
