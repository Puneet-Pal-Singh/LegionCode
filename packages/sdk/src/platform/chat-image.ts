import { ChatImageAttachmentRefSchema, HostedSessionParamsSchema, TurnIdSchema, type ChatImageAttachmentRef, type TurnId } from "@repo/platform-protocol";
import { CHAT_IMAGE_CHUNK_MAX_BYTES } from "@legioncode/app-server/protocol";
import { z } from "zod";
import type { AppServerClient } from "./app-server-client.js";

const ImageReadSourceSchema = z.union([
  z.object({ turnId: TurnIdSchema, reference: ChatImageAttachmentRefSchema }).strict(),
  HostedSessionParamsSchema.extend({ reference: ChatImageAttachmentRefSchema }).strict(),
]);

/** Hydrates original image bytes through the authenticated SDK port. Callers
 * create/revoke their own transient Blob URLs only after this digest succeeds.
 */
export async function readChatImage(
  client: Pick<AppServerClient, "readChatImageChunk">,
  input: { turnId: TurnId; reference: ChatImageAttachmentRef } | { sessionId: string; reference: ChatImageAttachmentRef },
  options: { signal?: AbortSignal } = {},
) {
  const signal = options.signal;
  signal?.throwIfAborted();
  // Parsing captures an independent fixed scope/reference before the first transport await.
  const source = Object.freeze(ImageReadSourceSchema.parse(input));
  const reference = Object.freeze(source.reference);
  const requestScope = "sessionId" in source
    ? Object.freeze({ sessionId: source.sessionId, reference })
    : Object.freeze({ turnId: source.turnId, attachmentId: reference.attachmentId });
  const readChunk = client.readChatImageChunk.bind(client);
  const bytes = new Uint8Array(reference.byteSize);
  let offset = 0;
  let sha256: string | undefined;
  const maxChunks = Math.ceil(reference.byteSize / CHAT_IMAGE_CHUNK_MAX_BYTES);
  for (let index = 0; index < maxChunks && offset < reference.byteSize; index += 1) {
    signal?.throwIfAborted();
    const chunk = await readChunk({
      ...requestScope,
      offset, limit: CHAT_IMAGE_CHUNK_MAX_BYTES,
    });
    signal?.throwIfAborted();
    const expectedLength = Math.min(CHAT_IMAGE_CHUNK_MAX_BYTES, reference.byteSize - offset);
    if (chunk.offset !== offset || chunk.byteLength !== expectedLength ||
      chunk.reference.attachmentId !== reference.attachmentId || chunk.reference.name !== reference.name ||
      chunk.reference.mediaType !== reference.mediaType || chunk.reference.byteSize !== reference.byteSize ||
      chunk.nextOffset !== (offset + expectedLength < reference.byteSize ? offset + expectedLength : null) ||
      (sha256 !== undefined && sha256 !== chunk.sha256)) throw unavailable();
    sha256 = chunk.sha256;
    const decoded = atob(chunk.dataBase64);
    if (decoded.length !== expectedLength) throw unavailable();
    for (let byte = 0; byte < decoded.length; byte += 1) bytes[offset + byte] = decoded.charCodeAt(byte);
    offset += decoded.length;
  }
  if (offset !== reference.byteSize || !sha256) throw unavailable();
  const actualDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  signal?.throwIfAborted();
  if (actualDigest !== sha256) throw unavailable();
  return { reference, bytes, mediaType: reference.mediaType, sha256 };
}
function unavailable(): Error {
  return new Error("Conversation image bytes could not be verified");
}
