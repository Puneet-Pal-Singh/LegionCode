import { useEffect, type RefObject } from "react";

/** Resize the controlled draft after input, reveal, or available-width changes. */
export function useChatComposerTextareaAutosize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  input: string,
  hasInput: boolean,
  isHidden: boolean,
): void {
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const resize = (): void => {
      textarea.style.height = "auto";
      const maxHeight = hasInput ? 200 : 400;
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;

    let observedWidth: number | undefined;
    let frame: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === observedWidth) return;
      observedWidth = entry.contentRect.width;
      if (frame !== null) cancelAnimationFrame(frame);
      // Keep height writes outside the observer delivery cycle. Height-only
      // notifications must not schedule another resize.
      frame = requestAnimationFrame(() => {
        frame = null;
        resize();
      });
    });
    observer.observe(textarea);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [textareaRef, input, hasInput, isHidden]);
}
