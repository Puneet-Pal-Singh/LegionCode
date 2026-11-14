import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { X } from "lucide-react";

export function ReviewDialogFrame({
  isOpen,
  onClose,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  children: (context: {
    titleId: string;
    closeButtonRef: RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
}) {
  const dialogTitleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements =
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
      if (!focusableElements || focusableElements.length === 0) {
        return;
      }

      const focusable = Array.from(focusableElements);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);
  if (!isOpen) return null;
  return (
    <div className="ui-overlay fixed inset-0 z-[120] flex items-center justify-center p-6">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close git review"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        className="ui-surface-modal relative flex h-[92vh] w-[94vw] max-w-[1600px] flex-col overflow-hidden"
      >
        {children({ titleId: dialogTitleId, closeButtonRef })}
      </div>
    </div>
  );
}

export function ReviewDialogCloseButton({
  onClose,
  buttonRef,
}: {
  onClose: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClose}
      className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
      aria-label="Close review"
    >
      <X size={16} />
    </button>
  );
}
