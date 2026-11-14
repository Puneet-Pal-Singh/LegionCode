import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatMediaImageType } from "@repo/platform-protocol";

export interface ChatImagePreviewSource {
  readonly token: string;
}
export type ChatImageOriginalReader<Source extends ChatImagePreviewSource> = (
  source: Source,
  options: { signal: AbortSignal },
) => Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly mediaType: ChatMediaImageType }>;

const PREVIEW_CONCURRENCY = 2;

/** Transient presentation only. The injected reader authenticates immutable originals. */
export function useChatImagePreviews<Source extends ChatImagePreviewSource>({
  sources, readOriginal, invalidMetadata = false,
}: {
  readonly sources: readonly Source[];
  readonly readOriginal: ChatImageOriginalReader<Source>;
  readonly invalidMetadata?: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const scope = useMemo(
    () => ({ sources, readOriginal, revision }),
    [sources, readOriginal, revision],
  );
  const [read, setRead] = useState<{
    scope: typeof scope;
    urls: ReadonlyMap<string, string>;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (scope.sources.length === 0) return;
    const controller = new AbortController();
    const urls = new Map<string, string>();
    const known = new Map(scope.sources.map((source) => [source.token, source]));
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
            const image = await scope.readOriginal(source, { signal: controller.signal });
            if (!active) return;
            urls.set(
              source.token,
              URL.createObjectURL(new Blob([image.bytes], { type: image.mediaType })),
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
      if (!token || queued.has(token) || urls.has(token) || failures.has(token)) return;
      const source = known.get(token);
      if (!source) return;
      queued.add(token);
      queue.push(source);
      pump();
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) enqueue(entry.target.getAttribute("data-chat-image-source"));
      },
      { rootMargin: "160px" },
    );
    const observed = new WeakMap<Element, string>();
    const discover = () => {
      for (const element of document.querySelectorAll("[data-chat-image-source]")) {
        const token = element.getAttribute("data-chat-image-source");
        if (!token || !known.has(token) || observed.get(element) === token) continue;
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
    (source: string) => read?.scope === scope ? read.urls.get(source) : undefined,
    [read, scope],
  );
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return {
    resolveSource,
    retry,
    error: invalidMetadata ? "Saved image metadata could not be read."
      : read?.scope === scope && read.failed ? "Some saved image previews could not be loaded." : null,
  };
}
