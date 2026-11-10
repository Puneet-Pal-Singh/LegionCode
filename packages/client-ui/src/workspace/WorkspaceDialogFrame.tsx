import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useModalFocus } from "../hooks/modal-focus.js";

/** Existing project-picker frame; hosts retain portal and background-inert ownership. */
export function WorkspaceDialogFrame({
  labelledBy,
  onClose,
  closeDisabled = false,
  closeLabel = "Close",
  children,
}: {
  labelledBy: string;
  onClose?: () => void;
  closeDisabled?: boolean;
  closeLabel?: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus({
    isOpen: true,
    modalRef: dialogRef,
    onClose: () => { if (!closeDisabled) onClose?.(); },
  });

  return (
    <main
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      className="relative flex max-h-[calc(100dvh-3rem)] min-h-0 w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-[#111113] text-zinc-100 shadow-2xl"
    >
      {onClose ? (
        <button type="button" onClick={onClose} disabled={closeDisabled} aria-label={closeLabel}
          className="absolute right-4 top-4 z-10 rounded-md p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:opacity-40">
          <X size={17} />
        </button>
      ) : null}
      {children}
    </main>
  );
}
