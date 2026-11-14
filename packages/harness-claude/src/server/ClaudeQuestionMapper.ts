import {
  ScopedRequestReply,
  HarnessHostError,
} from "@repo/harness-core/server";
import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ItemIdSchema, JsonRecordSchema, UserInputRequestSchema, normalizeUserInputResponse } from "@repo/platform-protocol";
import type { JsonRecord } from "@repo/platform-protocol";
import type {
  HarnessObservationPayload,
  HarnessRequestOrigin,
  HarnessSession,
  HarnessUserInputReply,
} from "@repo/worker-protocol";

const Option = z
  .object({
    label: z.string().min(1).max(240),
    description: z.string().max(1000),
    preview: z.string().max(16_384).optional(),
  })
  .strict();
const Question = z
  .object({
    question: z.string().min(1).max(2000),
    header: z.string().max(12),
    options: z.array(Option).min(2).max(4),
    multiSelect: z.boolean(),
  })
  .strict();
const Input = z.object({ questions: z.array(Question).min(1).max(4) });

/** Private native validation. Public request/response transport remains canonical user_input. */
export function claudeQuestion(input: unknown, replyTo: HarnessRequestOrigin) {
  const { questions } = Input.parse(input);
  if (
    new Set(questions.map((question) => question.question)).size !==
      questions.length ||
    questions.some(
      (question) =>
        new Set(question.options.map((option) => option.label)).size !==
        question.options.length,
    )
  ) {
    throw new Error("Claude questions or option labels are ambiguous");
  }
  const identity = createHash("sha256")
    .update(JSON.stringify(replyTo))
    .digest("hex")
    .slice(0, 40);
  const descriptor = UserInputRequestSchema.parse({
    prompt: null,
    questions: questions.map((question, index) => ({
      id: `claude-question-${index + 1}`,
      header: question.header,
      question: question.question,
      multiple: question.multiSelect,
      required: true,
      allowCustom: true,
      customMultiple: false,
      maxAnswerLength: 8000,
      options: question.options.map((option) => ({
        id: option.label, label: option.label, description: option.description,
      })),
    })),
  });
  const observation: Extract<
    HarnessObservationPayload,
    { kind: "user_input_requested" }
  > = {
    kind: "user_input_requested",
    replyTo,
    itemId: ItemIdSchema.parse(`itm_question_${identity}`),
    requestId: `claude_question_${identity}`,
    payload: descriptor,
  };
  return {
    observation,
    answer(response: JsonRecord): JsonRecord {
      const normalized = normalizeUserInputResponse(descriptor, response);
      const nativeAnswers = Object.fromEntries(questions.map((question, index) => {
        const values = normalized.answers[`claude-question-${index + 1}`]!.answers;
        const custom = values.some((value) => !question.options.some((option) => option.label === value));
        return [question.question, custom ? values[0] : values];
      }));
      response = JsonRecordSchema.parse({ answers: nativeAnswers });
      if (Object.keys(response).some((key) => key !== "answers"))
        throw new Error("Unsupported Claude question response fields");
      const answers = JsonRecordSchema.parse(response.answers);
      if (
        Object.keys(answers).length !== questions.length ||
        questions.some((question) => !Object.hasOwn(answers, question.question))
      )
        throw new Error("Claude answers must use the exact question texts");
      const entries = questions.map((question) => {
        const answer = answers[question.question];
        if (
          typeof answer === "string" &&
          answer.trim() &&
          answer.length <= 8000
        )
          return [question.question, answer];
        if (
          !Array.isArray(answer) ||
          answer.length === 0 ||
          (!question.multiSelect && answer.length !== 1) ||
          answer.length > question.options.length ||
          new Set(answer).size !== answer.length ||
          answer.some(
            (label) =>
              typeof label !== "string" ||
              !question.options.some((option) => option.label === label),
          )
        )
          throw new Error("Invalid Claude selected labels or free text");
        return [question.question, answer.join(", ")];
      });
      // Rebuild only native supported fields, never forward arbitrary response input.
      return JsonRecordSchema.parse({
        questions,
        answers: Object.fromEntries(entries),
      });
    },
  };
}

interface PendingQuestion {
  readonly reply: ScopedRequestReply<JsonRecord | null>;
  readonly committed: Promise<void>;
  readonly answer: (response: JsonRecord) => JsonRecord;
  readonly cancel: () => void;
}

/** Native callback handles only; canonical user-input persistence/decision stays in runtime. */
export class ClaudeQuestionRequests {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(
    private readonly options: {
      readonly session: HarnessSession;
      readonly authOwnerGeneration: number;
      readonly active: () => boolean;
      readonly observe: (payload: HarnessObservationPayload) => Promise<void>;
    },
  ) {}

  async request(
    input: Parameters<CanUseTool>[1],
    origin: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const deny = {
      behavior: "deny",
      message: "Claude question is no longer active",
      interrupt: true,
    } as const;
    if (
      !this.options.active() ||
      origin.signal.aborted ||
      this.pending.has(origin.requestId) ||
      this.pending.size >= 128
    )
      return deny;
    const replyTo: HarnessRequestOrigin = {
      session: this.options.session,
      origin: "claude.AskUserQuestion",
      requestId: origin.requestId,
      authOwnerGeneration: this.options.authOwnerGeneration,
    };
    let question: ReturnType<typeof claudeQuestion>;
    try {
      question = claudeQuestion(input, replyTo);
    } catch {
      return {
        behavior: "deny",
        message: "Claude question input is invalid or unsupported",
      };
    }
    let pending: PendingQuestion | undefined;
    const answer = new Promise<JsonRecord | null>((resolve) => {
      const reply = new ScopedRequestReply<JsonRecord | null>(
        origin.requestId,
        replyTo.origin,
        replyTo.session.processGeneration,
        replyTo.authOwnerGeneration,
        async (value) => {
          resolve(value);
        },
        () => this.options.active() && !origin.signal.aborted,
      );
      const cancel = () => {
        reply.fence();
        resolve(null);
      };
      const committed = Promise.resolve().then(() =>
        this.options.observe(question.observation),
      );
      pending = { reply, cancel, committed, answer: question.answer };
      this.pending.set(origin.requestId, pending);
      void committed.catch(cancel);
    });
    const abort = () => pending?.cancel();
    origin.signal.addEventListener("abort", abort, { once: true });
    try {
      const updatedInput = await answer;
      if (!updatedInput || !this.options.active() || origin.signal.aborted)
        return deny;
      return { behavior: "allow", updatedInput, toolUseID: origin.toolUseID };
    } finally {
      origin.signal.removeEventListener("abort", abort);
      this.pending.delete(origin.requestId);
    }
  }

  async respond(reply: HarnessUserInputReply): Promise<void> {
    const origin = reply.replyTo;
    if (
      !this.options.active() ||
      origin.authOwnerGeneration !== this.options.authOwnerGeneration ||
      JSON.stringify(origin.session) !== JSON.stringify(this.options.session)
    )
      throw new HarnessHostError("request_unavailable");
    const pending = this.pending.get(origin.requestId);
    if (!pending) throw new HarnessHostError("request_unavailable");
    await pending.committed;
    let answer: JsonRecord;
    try {
      answer = pending.answer(reply.response);
    } catch {
      pending.cancel();
      throw new HarnessHostError("request_unavailable");
    }
    await pending.reply.reply({
      requestId: origin.requestId,
      origin: origin.origin,
      processGeneration: origin.session.processGeneration,
      authOwnerGeneration: origin.authOwnerGeneration,
      value: answer,
    });
  }

  cancel(): void {
    for (const pending of this.pending.values()) pending.cancel();
  }
}
