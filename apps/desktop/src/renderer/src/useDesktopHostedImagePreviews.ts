import { useCallback, useMemo } from "react";
import { useChatImagePreviews, type ChatImageOriginalReader } from "@legioncode/client-ui";
import { readChatImage, type AppServerClient } from "@legioncode/sdk";
import { ChatImageAttachmentRefSchema, HostedSessionParamsSchema, type ChatImageAttachmentRef } from "@repo/platform-protocol";

type Source = { readonly sessionId: string; readonly reference: ChatImageAttachmentRef; readonly token: string };
const emptyMessages: readonly { readonly data?: unknown }[] = [];
const emptyReferences: readonly ChatImageAttachmentRef[] = [];

/** Session-scoped ephemeral previews. Only validated references cross the private SDK transport. */
export function useDesktopHostedImagePreviews(
  client: Pick<AppServerClient, "readChatImageChunk">,
  sessionId: string,
  input: { readonly messages?: readonly { readonly data?: unknown }[]; readonly references?: readonly ChatImageAttachmentRef[] },
) {
  const messages = input.messages ?? emptyMessages;
  const references = input.references ?? emptyReferences;
  const descriptor = useMemo(() => {
    const session = HostedSessionParamsSchema.parse({ sessionId });
    const byAttachment = new Map<string, Source>();
    const rejected = new Set<string>();
    let invalid = false;
    const add = (value: unknown, expectedSource?: unknown) => {
      const parsed = ChatImageAttachmentRefSchema.safeParse(value);
      if (!parsed.success) { invalid = true; return; }
      const reference = parsed.data;
      const token = `/api/chat/media/${encodeURIComponent(reference.attachmentId)}?session=${encodeURIComponent(session.sessionId)}`;
      if (expectedSource !== undefined && expectedSource !== token) { invalid = true; return; }
      const existing = byAttachment.get(reference.attachmentId);
      if (rejected.has(reference.attachmentId)) return;
      if (existing && JSON.stringify(existing.reference) !== JSON.stringify(reference)) {
        invalid = true;
        rejected.add(reference.attachmentId);
        byAttachment.delete(reference.attachmentId);
        return;
      }
      byAttachment.set(reference.attachmentId, { sessionId: session.sessionId, reference, token });
    };
    for (const message of messages) {
      const metadata = record(record(message.data)?.metadata);
      const images = metadata?.imageAttachments;
      if (images === undefined) continue;
      if (!Array.isArray(images) || images.length > 8) { invalid = true; continue; }
      for (const image of images) {
        const data = record(image);
        if (!data) { invalid = true; continue; }
        const { src, ...reference } = data;
        add(reference, src);
      }
    }
    for (const reference of references) add(reference);
    return { sources: [...byAttachment.values()], byAttachment, invalid };
  }, [sessionId, messages, references]);
  const readOriginal = useCallback<ChatImageOriginalReader<Source>>(
    (source, options) => readChatImage(client, { sessionId: source.sessionId, reference: source.reference }, options),
    [client],
  );
  const previews = useChatImagePreviews({ sources: descriptor.sources, readOriginal, invalidMetadata: descriptor.invalid });
  return {
    ...previews,
    sourceId: (attachmentId: string) => descriptor.byAttachment.get(attachmentId)?.token,
    resolveAttachmentSource: (attachmentId: string) => {
      const token = descriptor.byAttachment.get(attachmentId)?.token;
      return token ? previews.resolveSource(token) : undefined;
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
