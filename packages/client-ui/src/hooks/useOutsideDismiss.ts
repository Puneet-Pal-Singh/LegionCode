import { useEffect, type RefObject } from "react";

const NO_ADDITIONAL_REFS: readonly RefObject<HTMLElement | null>[] = [];

export function useOutsideDismiss(
  ref: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onDismiss: () => void,
  {
    additionalRefs = NO_ADDITIONAL_REFS,
    escapeFocusRef,
  }: {
    additionalRefs?: readonly RefObject<HTMLElement | null>[];
    escapeFocusRef?: RefObject<HTMLElement | null>;
  } = {},
): void {
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !ref.current?.contains(target) &&
        !additionalRefs.some((insideRef) => insideRef.current?.contains(target))
      ) {
        onDismiss();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !escapeFocusRef ||
        event.key !== "Escape" ||
        event.defaultPrevented
      ) return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      escapeFocusRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    if (escapeFocusRef) document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      if (escapeFocusRef) document.removeEventListener("keydown", handleKeyDown);
    };
  }, [additionalRefs, escapeFocusRef, isOpen, onDismiss, ref]);
}
