import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ChatImageAttachmentRefSchema, UserIdSchema, WorkspaceIdSchema, ThreadIdSchema,
  RunIdSchema, TurnIdSchema, RunAttemptIdSchema,
} from "@repo/platform-protocol";
import type { LocalTurnMediaScope } from "./local-turn-media.js";
import { CHAT_MEDIA_MAX_IMAGE_BYTES } from "@repo/chat-media/validation";

export const LOCAL_CHAT_MEDIA_LIMITS = Object.freeze({
  maxImages: 4, maxImageBytes: CHAT_MEDIA_MAX_IMAGE_BYTES, maxTotalBytes: 10 * 1024 * 1024,
});

export const LocalChatMediaScopeSchema = z.object({
  userId: UserIdSchema, workspaceId: WorkspaceIdSchema, threadId: ThreadIdSchema,
  runId: RunIdSchema, turnId: TurnIdSchema, runAttemptId: RunAttemptIdSchema,
}).strict();
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const LocalChatMediaRecordSchema = z.object({
  version: z.literal(1),
  scope: LocalChatMediaScopeSchema,
  fingerprint: DigestSchema,
  images: z.array(z.object({ reference: ChatImageAttachmentRefSchema, sha256: DigestSchema }).strict()).min(1).max(LOCAL_CHAT_MEDIA_LIMITS.maxImages),
}).strict();
export type LocalChatMediaRecord = z.infer<typeof LocalChatMediaRecordSchema>;
export interface LocalDecodedChatImage {
  readonly bytes: Uint8Array;
  readonly mediaType: LocalChatMediaRecord["images"][number]["reference"]["mediaType"];
  readonly name: string;
  readonly sha256: string;
}
export class LocalChatMediaError extends Error {
  constructor(readonly code: "invalid_image" | "unavailable" | "conflict", message: string) {
    super(message);
    this.name = "LocalChatMediaError";
  }
}
export const mediaDigest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const mediaScopeKey = (input: LocalTurnMediaScope): string =>
  mediaDigest(JSON.stringify(LocalChatMediaScopeSchema.parse(input)));

export function mediaFingerprint(images: readonly LocalDecodedChatImage[]): string {
  return mediaDigest(JSON.stringify(images.map((image) => ({
    name: image.name, mediaType: image.mediaType, byteSize: image.bytes.byteLength, sha256: image.sha256,
  }))));
}
export function createMediaRecord(scope: LocalTurnMediaScope, images: readonly LocalDecodedChatImage[]): LocalChatMediaRecord {
  const verifiedScope = LocalChatMediaScopeSchema.parse(scope);
  const fingerprint = mediaFingerprint(images);
  return LocalChatMediaRecordSchema.parse({
    version: 1, scope: verifiedScope, fingerprint,
    images: images.map((image, index) => ({
      reference: {
        type: "image_attachment",
        attachmentId: attachmentId(verifiedScope, fingerprint, index),
        name: image.name, mediaType: image.mediaType, byteSize: image.bytes.byteLength,
      },
      sha256: image.sha256,
    })),
  });
}
export function verifyMediaRecord(input: unknown, scope: LocalTurnMediaScope): LocalChatMediaRecord {
  const record = LocalChatMediaRecordSchema.parse(input);
  const expectedScope = LocalChatMediaScopeSchema.parse(scope);
  const fingerprint = mediaDigest(JSON.stringify(record.images.map(({ reference, sha256 }) => ({
    name: reference.name, mediaType: reference.mediaType, byteSize: reference.byteSize, sha256,
  }))));
  if (JSON.stringify(record.scope) !== JSON.stringify(expectedScope) || record.fingerprint !== fingerprint ||
    record.images.some(({ reference }, index) => reference.attachmentId !== attachmentId(expectedScope, fingerprint, index)) ||
    record.images.reduce((sum, image) => sum + image.reference.byteSize, 0) > LOCAL_CHAT_MEDIA_LIMITS.maxTotalBytes) {
    throw new LocalChatMediaError("unavailable", "Stored image metadata could not be verified");
  }
  return record;
}
function attachmentId(scope: LocalTurnMediaScope, fingerprint: string, index: number): string {
  return createHash("sha256").update(JSON.stringify([scope, fingerprint, index])).digest("base64url");
}
