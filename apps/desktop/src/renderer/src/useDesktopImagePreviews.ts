import { useCallback, useEffect, useMemo, useState } from "react";
import { readLocalChatImage, type AppServerClient, type ConversationHistoryMessage } from "@legioncode/sdk";
import {
  ChatImageAttachmentRefSchema,
  type ChatImageAttachmentRef,
  TurnIdSchema,
  type TurnId,
} from "@repo/platform-protocol";

type MediaClient = Pick<AppServerClient, "readLocalChatImageChunk">;
type Source = {
  turnId: TurnId;
  reference: ChatImageAttachmentRef;
  token: string;
};
const PREVIEW_CONCURRENCY = 2;
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
  const [revision, setRevision] = useState(0);
  const scope = useMemo(
    () => ({ client, descriptor, revision }),
    [client, descriptor, revision],
  );
  const [read, setRead] = useState<{
    scope: typeof scope;
    urls: ReadonlyMap<string, string>;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (scope.descriptor.sources.length === 0) return;
    const controller = new AbortController();
    const urls = new Map<string, string>();
    const known = new Map(
      scope.descriptor.sources.map((source) => [source.token, source]),
    );
    const queued = new Set<string>();
    const failures = new Set<string>();
    const queue: Source[] = [];
    let active = true;
    let loading = 0;
    const publish = () => {
      if (active)
        setRead({ scope, urls: new Map(urls), failed: failures.size > 0 });
    };
    const pump = () => {
      while (active && loading < PREVIEW_CONCURRENCY && queue.length) {
        const source = queue.shift()!;
        loading += 1;
        void (async () => {
          try {
            const image = await readLocalChatImage(scope.client, source, {
              signal: controller.signal,
            });
            if (!active) return;
            urls.set(
              source.token,
              URL.createObjectURL(
                new Blob([image.bytes], { type: image.mediaType }),
              ),
            );
            publish();
          } catch {
            if (active && !controller.signal.aborted) {
              failures.add(source.token);
              publish();
            }
          } finally {
            loading -= 1;
            if (active) pump();
          }
        })();
      }
    };
    const enqueue = (token: string | null) => {
      if (!token || queued.has(token) || urls.has(token) || failures.has(token))
        return;
      const source = known.get(token);
      if (!source) return;
      queued.add(token);
      queue.push(source);
      pump();
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries)
                if (entry.isIntersecting)
                  enqueue(entry.target.getAttribute("data-chat-image-source"));
            },
            { rootMargin: "160px" },
          );
    const observed = new WeakMap<Element, string>();
    const discover = () => {
      for (const element of document.querySelectorAll(
        "[data-chat-image-source]",
      )) {
        const token = element.getAttribute("data-chat-image-source");
        if (!token || !known.has(token) || observed.get(element) === token)
          continue;
        observed.set(element, token);
        if (observer) {
          observer.unobserve(element);
          observer.observe(element);
        } else enqueue(token);
      }
    };
    const mutations = new MutationObserver(discover);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-chat-image-source"],
    });
    discover();
    return () => {
      active = false;
      controller.abort();
      observer?.disconnect();
      mutations.disconnect();
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [scope]);

  const resolveSource = useCallback(
    (source: string) =>
      read?.scope === scope ? read.urls.get(source) : undefined,
    [read, scope],
  );
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return {
    referencesByMessage: descriptor.byMessage,
    resolveSource,
    retry,
    error: descriptor.invalid
      ? "Saved image metadata could not be read."
      : read?.scope === scope && read.failed
        ? "Some saved image previews could not be loaded."
        : null,
  };
}
