import { z } from "zod";
import { JsonValueSchema } from "./common.js";

/** Stable session-scoped history paging independent of execution availability. */
export const ConversationHistoryRequestSchema = z.object({
  session: z.string().uuid(),
  cursor: z.string().regex(/^\d+$/).refine((value) => Number.isSafeInteger(Number(value)), "cursor must be a safe integer").optional(),
  snapshot: z.string().regex(/^\d+$/).refine((value) => Number.isSafeInteger(Number(value)), "snapshot must be a safe integer").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.cursor !== undefined && value.snapshot === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["snapshot"], message: "snapshot is required with cursor" });
  }
  if (value.cursor !== undefined && value.snapshot !== undefined && Number(value.cursor) > Number(value.snapshot)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cursor"], message: "cursor cannot exceed snapshot" });
  }
});

export const ConversationHistoryMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(JsonValueSchema)]),
  createdAt: z.string().datetime({ offset: true }),
  data: z.object({ metadata: z.record(z.unknown()).optional() }).optional(),
}).strict();

export const ConversationHistoryResponseSchema = z.object({
  messages: z.array(ConversationHistoryMessageSchema),
  nextCursor: z.string().regex(/^\d+$/).refine((value) => Number.isSafeInteger(Number(value)), "nextCursor must be a safe integer").nullable(),
  snapshot: z.string().regex(/^\d+$/).refine((value) => Number.isSafeInteger(Number(value)), "snapshot must be a safe integer"),
}).strict().superRefine((value, context) => {
  if (value.nextCursor !== null && Number(value.nextCursor) > Number(value.snapshot)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nextCursor"], message: "nextCursor cannot exceed snapshot" });
  }
});

export type ConversationHistoryRequest = z.infer<typeof ConversationHistoryRequestSchema>;
export type ConversationHistoryMessage = z.infer<typeof ConversationHistoryMessageSchema>;
export type ConversationHistoryResponse = z.infer<typeof ConversationHistoryResponseSchema>;
