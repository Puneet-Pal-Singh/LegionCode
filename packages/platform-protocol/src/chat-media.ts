import { z } from "zod";

export const CHAT_MEDIA_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const ChatMediaImageTypeSchema = z.enum(CHAT_MEDIA_IMAGE_TYPES);
export type ChatMediaImageType = z.infer<typeof ChatMediaImageTypeSchema>;

/**
 * Durable transcript metadata for an image attachment.
 *
 * The object bytes live in the authenticated chat-media object store. This
 * contract intentionally contains no data URL, signed URL, or filesystem
 * path; URLs are added only when a client-facing transcript is hydrated.
 */
export const ChatImageAttachmentRefSchema = z
  .object({
    type: z.literal("image_attachment"),
    attachmentId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    name: z.string().trim().min(1).max(255),
    mediaType: ChatMediaImageTypeSchema,
    byteSize: z.number().int().positive().max(5 * 1024 * 1024),
  })
  .strict();

export type ChatImageAttachmentRef = z.infer<
  typeof ChatImageAttachmentRefSchema
>;
