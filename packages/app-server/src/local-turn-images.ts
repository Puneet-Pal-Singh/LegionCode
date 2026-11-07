import {
  ChatImageAttachmentRefSchema,
  ContentDigestSchema,
  ThreadItemSchema,
  type TurnAdmission,
} from "@repo/platform-protocol";
import type { createLocalNativeProviderPorts } from "@legioncode/execution-engine/runtime/desktop/LocalNativeProviderPorts";
import type { LocalTurnMediaPort, LocalTurnMediaScope, LocalTurnPreparedMedia } from "./local-turn-media.js";

type NativeMessage = Parameters<typeof createLocalNativeProviderPorts>[0]["messages"][number];

export function localTurnMediaScope(admission: TurnAdmission): LocalTurnMediaScope {
  return {
    userId: admission.run.userId,
    workspaceId: admission.run.workspaceId,
    threadId: admission.run.threadId,
    runId: admission.run.id,
    turnId: admission.turn.id,
    runAttemptId: admission.runAttemptId,
  };
}

export function localTurnImageReferences(admission: TurnAdmission) {
  if (admission.userMessage.type !== "user_message") throw new Error("Local admission has no user message");
  const images = admission.userMessage.content.images;
  return images === undefined ? [] : ChatImageAttachmentRefSchema.array().parse(images);
}

/** Runtime calls this before atomic admission; no incomplete message is persisted. */
export async function attachPreparedLocalImages(
  admission: TurnAdmission,
  preparation: LocalTurnPreparedMedia,
  imageCount: number,
  media: LocalTurnMediaPort,
): Promise<TurnAdmission> {
  if (admission.userMessage.type !== "user_message") throw new Error("Local admission has no user message");
  const fingerprint = ContentDigestSchema.parse(preparation.fingerprint);
  const images = ChatImageAttachmentRefSchema.array().min(1).max(media.limits.maxImages).parse(
    await preparation.persist(localTurnMediaScope(admission)),
  );
  if (images.length !== imageCount || new Set(images.map((image) => image.attachmentId)).size !== images.length ||
      images.some((image) => image.byteSize > media.limits.maxImageBytes) ||
      images.reduce((total, image) => total + image.byteSize, 0) > media.limits.maxTotalBytes) {
    throw new Error("Local media returned inconsistent bounded image references");
  }
  return {
    ...admission,
    userMessage: ThreadItemSchema.parse({
      ...admission.userMessage,
      content: { ...admission.userMessage.content, images, imageFingerprint: fingerprint },
    }),
  };
}

/** Hydrate stored references for the provider; pixel data never becomes transcript metadata. */
export async function localUserProviderMessage(
  admission: TurnAdmission,
  media: LocalTurnMediaPort | undefined,
  signal: AbortSignal,
): Promise<NativeMessage> {
  if (admission.userMessage.type !== "user_message" || typeof admission.userMessage.content.text !== "string") {
    throw new Error("Canonical admission has no user prompt");
  }
  const text = admission.userMessage.content.text;
  const references = localTurnImageReferences(admission);
  if (!references.length) return { role: "user", content: text };
  const fingerprint = ContentDigestSchema.parse(admission.userMessage.content.imageFingerprint);
  if (!media) throw new Error("Stored conversation images are unavailable");
  const images = await media.resolveForProvider({ scope: localTurnMediaScope(admission), fingerprint, references, signal });
  signal.throwIfAborted();
  if (images.length !== references.length) throw new Error("Stored conversation image hydration is incomplete");
  const content: Exclude<Extract<NativeMessage, { role: "user" }>["content"], string> = [];
  if (text) content.push({ type: "text", text });
  content.push(...images);
  return { role: "user", content };
}
