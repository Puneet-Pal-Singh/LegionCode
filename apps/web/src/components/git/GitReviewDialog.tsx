import { useEffect, useId, useRef, useState } from "react";
import { FileDiff, GitBranch, X } from "lucide-react";
import { ChangesPanel } from "../sidebar/ChangesPanel";
import { useGitReview } from "./GitReviewContext";
import { GitCommitDialog } from "./GitCommitDialog";

const REVIEW_COMMIT_ENTRY_POINT_ENABLED = false;

interface GitReviewDialogProps {
  initialIntent?: "review" | "commit";
}

export function GitReviewDialog({
  initialIntent = "review",
}: GitReviewDialogProps) {
  const {
    isReviewOpen,
    closeReview,
    status,
    selectedFile,
    selectedReviewCommentCount,
    selectFile,
  } = useGitReview();
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(
    initialIntent === "commit",
  );
  const dialogTitleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeReviewRef = useRef(closeReview);

  useEffect(() => {
    closeReviewRef.current = closeReview;
  }, [closeReview]);

  useEffect(() => {
    if (!isReviewOpen || selectedFile || !status?.files.length) {
      return;
    }

    const [firstFile] = status.files;
    if (firstFile) {
      selectFile(firstFile);
    }
  }, [isReviewOpen, selectFile, selectedFile, status?.files]);

  useEffect(() => {
    if (!isReviewOpen) {
      return;
    }

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeReviewRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = dialogRef.current?.querySelectorAll<HTMLElement>(
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
  }, [isReviewOpen]);

  if (!isReviewOpen) {
    return null;
  }

  return (
    <div className="ui-overlay fixed inset-0 z-[120] flex items-center justify-center px-6 py-8">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close git review"
        onClick={closeReview}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        className="ui-surface-modal relative flex h-full max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between border-b ui-muted-divider bg-zinc-950/70 px-5 py-4">
          <div className="min-w-0">
            <div
              id={dialogTitleId}
              className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500"
            >
              <FileDiff size={14} />
              Review Changes
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-zinc-300">
              <span className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 font-medium text-zinc-200">
                <GitBranch size={14} className="text-emerald-400" />
                {status?.branch || "No branch"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={closeReview}
              disabled={selectedReviewCommentCount === 0}
              className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-300 transition-colors hover:border-sky-400/40 hover:bg-sky-500/15 hover:text-sky-200 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
            >
              Review changes ({selectedReviewCommentCount})
            </button>
            {/* TODO: Set REVIEW_COMMIT_ENTRY_POINT_ENABLED true after GitCommitDialog is reliable in production. */}
            {REVIEW_COMMIT_ENTRY_POINT_ENABLED ? (
              <button
                type="button"
                onClick={() => setIsCommitDialogOpen(true)}
                className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 transition-colors hover:border-emerald-400/40 hover:bg-emerald-500/15 hover:text-emerald-200"
              >
                Commit
              </button>
            ) : null}

            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeReview}
              className="rounded-lg border border-zinc-800 p-2 text-zinc-400 transition-colors hover:border-zinc-700 hover:text-white"
              aria-label="Close review"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <ChangesPanel className="h-full p-5" mode="modal" />
        </div>

        <GitCommitDialog
          key={isCommitDialogOpen ? "commit-open" : "commit-closed"}
          isOpen={isCommitDialogOpen}
          onClose={() => setIsCommitDialogOpen(false)}
        />
      </div>
    </div>
  );
}
