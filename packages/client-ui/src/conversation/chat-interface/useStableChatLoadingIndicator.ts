import { useEffect, useRef, useState } from "react";

const CHAT_READY_STABILITY_MS = 180;

export function useStableChatLoadingIndicator(
  isLoading: boolean,
  hideImmediately = false,
): boolean {
  const [isVisible, setIsVisible] = useState(isLoading);
  const latestLoadingRef = useRef(isLoading);

  useEffect(() => {
    latestLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    if (isLoading) {
      // Deliberately latch visibility before paint: deriving only from
      // `isLoading` would drop the stability window on the next render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsVisible(true);
      return;
    }

    if (!isVisible) return;
    const timeoutId = window.setTimeout(() => {
      // A terminal replay can start a second transcript hydration in the same
      // frame that this timer matures. Never reveal using that stale ready
      // signal; require one uninterrupted quiet window instead.
      if (latestLoadingRef.current) return;
      setIsVisible(false);
    }, CHAT_READY_STABILITY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isLoading, isVisible]);

  // A task switch must cover the surface in the same render that loading
  // begins. Waiting for the effect above would expose one frame of the newly
  // selected task (including its approval dock) before the loader appears.
  return hideImmediately ? false : isLoading || isVisible;
}
