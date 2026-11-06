import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Folder, Globe2, ShieldAlert, Terminal } from "lucide-react";

interface FullAccessConfirmationProps {
  onCancel: () => void;
  onConfirm: () => void;
}

export function FullAccessConfirmation({
  onCancel,
  onConfirm,
}: FullAccessConfirmationProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const first = focusable.item(0);
    const last = focusable.item(focusable.length - 1);
    if (!first || !last) return;
    const focusIsInside = dialogRef.current?.contains(document.activeElement);
    if (!focusIsInside) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="full-access-title"
      aria-describedby="full-access-description"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      className="fixed inset-0 z-[60] flex h-dvh items-center justify-center overflow-y-auto bg-black/70 p-4 text-left"
      data-testid="full-access-confirmation"
    >
      <section className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-zinc-700/80 bg-zinc-950 p-5 text-zinc-100 shadow-2xl shadow-black/50 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-amber-400/20 bg-amber-400/10 text-amber-300">
            <ShieldAlert size={19} aria-hidden="true" />
          </span>
          <div>
            <h2
              id="full-access-title"
              className="text-base font-semibold tracking-tight"
            >
              Turn on Full Access?
            </h2>
            <p
              id="full-access-description"
              className="mt-1 text-sm leading-5 text-zinc-400"
            >
              Give the agent broader control of this hosted workspace.
            </p>
          </div>
        </div>

        <ul className="mt-5 divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900/40">
          <li className="flex items-center gap-3 px-3.5 py-3 text-sm text-zinc-200">
            <Folder
              size={16}
              className="shrink-0 text-sky-300"
              aria-hidden="true"
            />
            <span>
              <span className="block font-medium">Files and folders</span>
              <span className="mt-0.5 block text-xs text-zinc-500">
                Read and edit project files in this workspace
              </span>
            </span>
          </li>
          <li className="flex items-center gap-3 px-3.5 py-3 text-sm text-zinc-200">
            <Terminal
              size={16}
              className="shrink-0 text-emerald-300"
              aria-hidden="true"
            />
            <span>
              <span className="block font-medium">Terminal commands</span>
              <span className="mt-0.5 block text-xs text-zinc-500">
                Run commands in the workspace environment
              </span>
            </span>
          </li>
          <li className="flex items-center gap-3 px-3.5 py-3 text-sm text-zinc-400">
            <Globe2
              size={16}
              className="shrink-0 text-violet-300"
              aria-hidden="true"
            />
            <span>
              <span className="block font-medium text-zinc-200">
                Network and integrations
              </span>
              <span className="mt-0.5 block text-xs text-zinc-500">
                Use services available to this workspace
              </span>
            </span>
          </li>
        </ul>

        <p className="mt-3 text-xs leading-5 text-zinc-500">
          Workspace access controls still apply. This does not grant access to
          files on your computer.
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-full border border-zinc-700 bg-zinc-900/60 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-full border border-rose-700/70 bg-rose-950/80 px-4 py-2 text-sm font-semibold text-rose-100 transition hover:border-rose-600 hover:bg-rose-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
          >
            Confirm
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
