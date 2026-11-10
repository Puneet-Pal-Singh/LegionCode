import { z } from "zod";

const QuestionIdSchema = z.string().min(1).max(160).refine(
  (value) => value.trim().length > 0 && !["__proto__", "prototype", "constructor"].includes(value),
  "Invalid question identity",
);
const OptionIdSchema = z.string().min(1).max(1024);
const QuestionOptionSchema = z.object({
  id: OptionIdSchema,
  label: z.string().min(1).max(1024),
  description: z.string().max(4096).nullable(),
}).strict();

/** Public, provider-independent form. Native mappers retain stricter constraints. */
export const UserInputQuestionSchema = z.object({
  id: QuestionIdSchema,
  header: z.string().max(240).nullable(),
  question: z.string().min(1).max(8192),
  multiple: z.boolean(),
  required: z.boolean(),
  allowCustom: z.boolean(),
  /** Some native forms permit one free-text answer alongside multi-select options. */
  customMultiple: z.boolean(),
  maxAnswerLength: z.number().int().min(1).max(8192),
  options: z.array(QuestionOptionSchema).max(32),
}).strict().superRefine((question, context) => {
  if (new Set(question.options.map((option) => option.id)).size !== question.options.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "Question options must have distinct identities" });
  if (!question.allowCustom && question.options.length === 0)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "Question has no supported answer" });
});
export type UserInputQuestion = z.infer<typeof UserInputQuestionSchema>;

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const UserInputRequestSchema = z.object({
  prompt: z.string().max(8192).nullable(),
  questions: z.array(UserInputQuestionSchema).min(1).max(8),
}).strict().superRefine((request, context) => {
  if (new Set(request.questions.map((question) => question.id)).size !== request.questions.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["questions"], message: "Questions must have distinct identities" });
  if (byteLength(request) > 65_536)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Question form exceeds its byte bound" });
});
export type UserInputRequest = z.infer<typeof UserInputRequestSchema>;

export const UserInputResponseSchema = z.object({
  answers: z.record(QuestionIdSchema, z.object({
    answers: z.array(z.string().max(8192)).max(32),
  }).strict()),
}).strict().superRefine((response, context) => {
  if (Object.keys(response.answers).length > 8 || byteLength(response) > 65_536)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Question response exceeds its bound" });
});
export type UserInputResponse = z.infer<typeof UserInputResponseSchema>;

/** Pure validation/normalization, before reservations, claims, append or effects.
 * Preserve exact option IDs/free text and deterministic descriptor order.
 */
export function normalizeUserInputResponse(requestInput: unknown, responseInput: unknown): UserInputResponse {
  const request = UserInputRequestSchema.parse(requestInput);
  const response = UserInputResponseSchema.parse(responseInput);
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  for (const id of Object.keys(response.answers)) {
    if (!questions.has(id)) throw new Error("Question response has an unknown identity");
  }
  const answers: UserInputResponse["answers"] = Object.create(null);
  for (const question of request.questions) {
    const values = response.answers[question.id]?.answers ?? [];
    if ((question.required && (values.length === 0 || values.some((value) => value.length === 0))) ||
        (!question.multiple && values.length > 1) ||
        new Set(values).size !== values.length ||
        values.some((value) => value.length > question.maxAnswerLength))
      throw new Error("Question response violates its answer constraints");
    const offered = new Set(question.options.map((option) => option.id));
    const hasCustom = values.some((value) => !offered.has(value));
    if ((!question.allowCustom && hasCustom) ||
        values.some((value) => !offered.has(value) && !value.trim()) ||
        (hasCustom && !question.customMultiple && values.length > 1))
      throw new Error("Question response contains an unavailable option");
    answers[question.id] = { answers: [...values] };
  }
  return UserInputResponseSchema.parse({ answers });
}
