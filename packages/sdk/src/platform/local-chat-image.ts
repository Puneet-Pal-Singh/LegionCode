import { ChatImageAttachmentRefSchema, type ChatImageAttachmentRef, type TurnId } from "@repo/platform-protocol";
import { LOCAL_CHAT_IMAGE_CHUNK_MAX_BYTES } from "@legioncode/app-server/protocol";
import type { AppServerClient } from "./app-server-client.js";

/** Hydrates original image bytes through the authenticated SDK port. Callers
 * create/revoke their own transient Blob URLs only after this digest succeeds.
 */
export async function readLocalChatImage(
  client: Pick<AppServerClient, "readLocalChatImageChunk">,
  input: { turnId: TurnId; reference: ChatImageAttachmentRef },
  options: { signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const reference = ChatImageAttachmentRefSchema.parse(input.reference);
  const bytes = new Uint8Array(reference.byteSize);
  let offset = 0;
  let sha256: string | undefined;
  const maxChunks = Math.ceil(reference.byteSize / LOCAL_CHAT_IMAGE_CHUNK_MAX_BYTES);
  for (let index = 0; index < maxChunks && offset < reference.byteSize; index += 1) {
    options.signal?.throwIfAborted();
    const chunk = await client.readLocalChatImageChunk({
      turnId: input.turnId, attachmentId: reference.attachmentId,
      offset, limit: LOCAL_CHAT_IMAGE_CHUNK_MAX_BYTES,
    });
    options.signal?.throwIfAborted();
    const expectedLength = Math.min(LOCAL_CHAT_IMAGE_CHUNK_MAX_BYTES, reference.byteSize - offset);
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
  options.signal?.throwIfAborted();
  if (actualDigest !== sha256) throw unavailable();
  return { reference, bytes, mediaType: reference.mediaType, sha256 };
}
function unavailable(): Error {
  return new Error("Conversation image bytes could not be verified");
}
