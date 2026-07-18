import { z } from "zod";
import { ProtocolTimestampSchema } from "./common.js";
import { ThreadIdSchema } from "./ids.js";

/**
 * The origin of a durable title update. A preview is deterministic server-side
 * copy; generated copy is produced by the selected model; a user title always
 * takes precedence over both.
 */
export const ThreadTitleUpdateSourceSchema = z.enum([
  "preview",
  "generated",
  "user",
]);
export type ThreadTitleUpdateSource = z.infer<
  typeof ThreadTitleUpdateSourceSchema
>;

/**
 * Canonical event payload for replaying title changes. The event deliberately
 * contains only the first user-message identity and title metadata: never
 * prompt text, model output, tools, credentials, or private reasoning.
 */
export const ThreadTitleUpdatedPayloadSchema = z
  .object({
    threadId: ThreadIdSchema,
    firstMessageId: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(80),
    titleVersion: z.number().int().positive(),
    source: ThreadTitleUpdateSourceSchema,
    timestamp: ProtocolTimestampSchema,
  })
  .strict();
export type ThreadTitleUpdatedPayload = z.infer<
  typeof ThreadTitleUpdatedPayloadSchema
>;

export const GeneratedThreadTitleSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
  })
  .strict();
export type GeneratedThreadTitle = z.infer<typeof GeneratedThreadTitleSchema>;
