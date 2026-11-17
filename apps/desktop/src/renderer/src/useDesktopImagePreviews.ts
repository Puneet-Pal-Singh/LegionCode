import { useCallback, useMemo } from "react";
import { useChatImagePreviews, type ChatImageOriginalReader } from "@legioncode/client-ui";
import { readChatImage, type AppServerClient, type ConversationHistoryMessage } from "@legioncode/sdk";
import {
  ChatImageAttachmentRefSchema,
  type ChatImageAttachmentRef,
  TurnIdSchema,
  type TurnId,
} from "@repo/platform-protocol";

type MediaClient = Pick<AppServerClient, "readChatImageChunk">;
type Source = {
  turnId: TurnId;
  reference: ChatImageAttachmentRef;
  token: string;
};
export const desktopImageSource = (
  turnId: TurnId,
  attachmentId: string,
  messageId?: string,
): string => `local-image:${turnId}:${attachmentId}${messageId ? `:${messageId}` : ""}`;

/** Ephemeral view cache over authenticated immutable references. Bytes and identity remain server-owned. */
export function useDesktopImagePreviews(
  client: MediaClient,
  messages: readonly ConversationHistoryMessage[],
) {
  const descriptor = useMemo(() => {
    const sources: Source[] = [];
    const byMessage = new Map<string, Source[]>();
    let invalid = false;
    for (const message of messages) {
      const metadata = message.data?.metadata;
      const images = metadata?.imageAttachments;
      if (images === undefined) continue;
      const identity = metadata?.canonicalIdentity;
      const turn = identity && typeof identity === "object" && !Array.isArray(identity)
        ? TurnIdSchema.safeParse((identity as Record<string, unknown>).turnId) : null;
      if (!turn?.success || !Array.isArray(images) || images.length > 8) {
        invalid = true;
        continue;
      }
      const references: Source[] = [];
      for (const value of images) {
        const parsed = ChatImageAttachmentRefSchema.safeParse(value);
        if (!parsed.success) {
          invalid = true;
          continue;
        }
        const source = {
          turnId: turn.data,
          reference: parsed.data,
          token: desktopImageSource(
            turn.data,
            parsed.data.attachmentId,
            message.id,
          ),
        };
        references.push(source);
        sources.push(source);
      }
      byMessage.set(message.id, references);
    }
    return { sources, byMessage, invalid };
  }, [messages]);
  const readOriginal = useCallback<ChatImageOriginalReader<Source>>(
    (source, options) => readChatImage(client, source, options),
    [client],
  );
  const previews = useChatImagePreviews({
    sources: descriptor.sources, readOriginal, invalidMetadata: descriptor.invalid,
  });
  return { referencesByMessage: descriptor.byMessage, ...previews };
}
