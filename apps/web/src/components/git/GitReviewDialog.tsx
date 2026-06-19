import { useEffect, useId, useRef } from "react";
import { FileDiff, X } from "lucide-react";
import { ChangesPanel } from "../sidebar/ChangesPanel";
import { useGitReview } from "./useGitReview";

export function GitReviewDialog() {
  const {
    isReviewOpen,
    closeReview,
    status,
    selectedFile,
    reviewFiles,
    selectedReviewCommentCount,
    selectFile,
  } = useGitReview();
  const dialogTitleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeReviewRef = useRef(closeReview);

  useEffect(() => {
    closeReviewRef.current = closeReview;
  }, [closeReview]);

  useEffect(() => {
    if (!isReviewOpen || selectedFile || reviewFiles.length === 0) {
      return;
    }

    const [firstFile] = reviewFiles;
    if (firstFile) {
      selectFile(firstFile);
    }
  }, [isReviewOpen, reviewFiles, selectFile, selectedFile]);

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
  }, [isReviewOpen]);

  if (!isReviewOpen) {
    return null;
  }

  return (
    <div className="ui-overlay fixed inset-0 z-[120] flex items-center justify-center p-4">
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
        className="ui-surface-modal relative flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col overflow-hidden"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b ui-muted-divider bg-[#111113] px-3">
          <div
            id={dialogTitleId}
            role="tablist"
            aria-label="Review workspace tabs"
            className="flex min-w-0 items-center"
          >
            <div
              role="tab"
              aria-selected="true"
              className="flex h-9 items-center gap-2 rounded-xl bg-[#242426] px-3.5 text-sm font-medium text-zinc-100"
            >
              <FileDiff size={15} />
              Review
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeReview}
              className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
              aria-label="Close review"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <ChangesPanel
            className="h-full px-4 pb-4"
            mode="modal"
            layout="stacked"
            branch={status?.branch || "No branch"}
            reviewCommentCount={selectedReviewCommentCount}
            onReviewChanges={closeReview}
          />
        </div>
      </div>
    </div>
  );
}
