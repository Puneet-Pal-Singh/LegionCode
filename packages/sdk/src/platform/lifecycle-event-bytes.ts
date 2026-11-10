import {
  LifecycleEventBytesReferenceSchema,
  LifecycleEventSchema,
  LIFECYCLE_EVENT_CHUNK_MAX_BYTES,
  ReadLifecycleEventChunkResponseSchema,
  type LifecycleEvent,
  type LifecycleEventBytesReference,
  type ReadLifecycleEventChunkRequest,
  type ReadLifecycleEventChunkResponse,
} from "@repo/platform-protocol";

export class LifecycleEventBytesError extends Error {
  constructor() {
    super("Canonical lifecycle event bytes could not be verified");
    this.name = "LifecycleEventBytesError";
  }
}

/** Transfer bytes only. The canonical event remains unchanged and reaches the
 * existing replay ordering owner only after full identity and digest validation.
 */
export async function readLifecycleEventBytes(
  input: LifecycleEventBytesReference,
  readChunk: (request: ReadLifecycleEventChunkRequest) => Promise<ReadLifecycleEventChunkResponse>,
  options: { readonly signal?: AbortSignal; readonly backend?: ReadLifecycleEventChunkRequest["backend"] } = {},
): Promise<LifecycleEvent> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const parsedReference = LifecycleEventBytesReferenceSchema.safeParse(input);
  if (!parsedReference.success || !Number.isSafeInteger(parsedReference.data.sequence)) throw unavailable();
  const reference = parsedReference.data;
  const bytes = allocateBytes(reference.byteLength);
  let offset = 0;
  const maxChunks = Math.ceil(reference.byteLength / LIFECYCLE_EVENT_CHUNK_MAX_BYTES);
  for (let index = 0; index < maxChunks && offset < reference.byteLength; index += 1) {
    signal?.throwIfAborted();
    const expectedLength = Math.min(LIFECYCLE_EVENT_CHUNK_MAX_BYTES, reference.byteLength - offset);
    const response = await readChunk({
      turnId: reference.turnId,
      eventId: reference.eventId,
      sequence: reference.sequence,
      sha256: reference.sha256,
      offset,
      limit: expectedLength,
      ...(options.backend === undefined ? {} : { backend: options.backend }),
    });
    signal?.throwIfAborted();
    const parsed = ReadLifecycleEventChunkResponseSchema.safeParse(response);
    if (!parsed.success) throw unavailable();
    const chunk = parsed.data;
    if (chunk.offset !== offset || chunk.byteLength !== expectedLength ||
        chunk.reference.formatVersion !== reference.formatVersion ||
        chunk.reference.turnId !== reference.turnId || chunk.reference.eventId !== reference.eventId ||
        chunk.reference.sequence !== reference.sequence || chunk.reference.byteLength !== reference.byteLength ||
        chunk.reference.sha256 !== reference.sha256 ||
        chunk.nextOffset !== (offset + expectedLength < reference.byteLength ? offset + expectedLength : null)) {
      throw unavailable();
    }
    let decoded: string;
    try { decoded = atob(chunk.dataBase64); }
    catch { throw unavailable(); }
    if (decoded.length !== expectedLength) throw unavailable();
    for (let byte = 0; byte < decoded.length; byte += 1) bytes[offset + byte] = decoded.charCodeAt(byte);
    offset += expectedLength;
  }
  signal?.throwIfAborted();
  if (offset !== reference.byteLength) throw unavailable();
  let digest: ArrayBuffer;
  try { digest = await crypto.subtle.digest("SHA-256", bytes); }
  catch { signal?.throwIfAborted(); throw unavailable(); }
  signal?.throwIfAborted();
  const sha256 = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (sha256 !== reference.sha256) throw unavailable();
  let event: LifecycleEvent;
  try {
    event = LifecycleEventSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  } catch { throw unavailable(); }
  signal?.throwIfAborted();
  if (event.turnId !== reference.turnId || event.eventId !== reference.eventId || event.sequence !== reference.sequence) {
    throw unavailable();
  }
  return event;
}

function allocateBytes(byteLength: number) {
  try { return new Uint8Array(byteLength); }
  catch { throw unavailable(); }
}

function unavailable(): LifecycleEventBytesError {
  return new LifecycleEventBytesError();
}
