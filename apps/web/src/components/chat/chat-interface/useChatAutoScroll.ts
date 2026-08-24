import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

const BOTTOM_FOLLOW_THRESHOLD_PX = 120;

export function isChatNearBottom(
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    BOTTOM_FOLLOW_THRESHOLD_PX
  );
}

interface UseChatAutoScrollOptions {
  activeRun: boolean;
  latestMessageKey: string | null;
  lifecycleSequence: number;
  placeholderVisible: boolean;
  scopeKey: string;
  scrollRef: RefObject<HTMLDivElement | null>;
}

/**
 * Keeps canonical live continuation visible without stealing the scroll position
 * from someone who has deliberately moved up to read older transcript content.
 */
export function useChatAutoScroll({
  activeRun,
  latestMessageKey,
  lifecycleSequence,
  placeholderVisible,
  scopeKey,
  scrollRef,
}: UseChatAutoScrollOptions): void {
  const followBottomRef = useRef(true);
  const previousMessageKeyRef = useRef<string | null>(null);
  const previousPlaceholderRef = useRef(true);
  const previousScopeKeyRef = useRef<string | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const element = scrollRef.current;
    if (!element) return;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      element.scrollTo({ top: element.scrollHeight, behavior });
    });
  }, [scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const updateFollowState = () => {
      followBottomRef.current = isChatNearBottom(element);
    };
    element.addEventListener("scroll", updateFollowState, { passive: true });

    const content = element.firstElementChild;
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !content
        ? null
        : new ResizeObserver(() => {
            if (activeRun && followBottomRef.current) {
              scrollToBottom("auto");
            }
          });
    if (content) resizeObserver?.observe(content);

    return () => {
      element.removeEventListener("scroll", updateFollowState);
      resizeObserver?.disconnect();
    };
  }, [activeRun, scrollRef, scrollToBottom]);

  useLayoutEffect(() => {
    const loaderRevealed = previousPlaceholderRef.current;
    const scopeChanged = previousScopeKeyRef.current !== scopeKey;
    const messageChanged = previousMessageKeyRef.current !== latestMessageKey;

    previousPlaceholderRef.current = placeholderVisible;
    previousScopeKeyRef.current = scopeKey;
    previousMessageKeyRef.current = latestMessageKey;

    if (placeholderVisible) return;

    if (scopeChanged || loaderRevealed || messageChanged) {
      followBottomRef.current = true;
      scrollToBottom("auto");
      return;
    }

    if (followBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [
    activeRun,
    latestMessageKey,
    lifecycleSequence,
    placeholderVisible,
    scopeKey,
    scrollToBottom,
  ]);

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    },
    [],
  );
}
