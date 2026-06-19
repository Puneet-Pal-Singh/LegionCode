import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FileDiff, Files, Plus, X } from "lucide-react";
import { ChangesPanel } from "../sidebar/ChangesPanel";
import { FileChangesIcon } from "../sidebar/FileChangesIcon";
import { useOutsideDismiss } from "../../hooks/useOutsideDismiss";
import { useGitReview } from "./useGitReview";

interface GitReviewDialogProps {
  filesRail?: ReactNode;
}

type ReviewRail = "changes" | "files" | null;

export function GitReviewDialog({ filesRail }: GitReviewDialogProps) {
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
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [activeRail, setActiveRail] = useState<ReviewRail>(null);
  const closeAddMenu = useCallback(() => setIsAddMenuOpen(false), []);
  useOutsideDismiss(addMenuRef, isAddMenuOpen, closeAddMenu);

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
    <div className="ui-overlay fixed inset-0 z-[120] flex items-center justify-center p-6">
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
        className="ui-surface-modal relative flex h-[92vh] w-[94vw] max-w-[1600px] flex-col overflow-hidden"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b ui-muted-divider bg-[#111113] px-3">
          <div
            id={dialogTitleId}
            role="tablist"
            aria-label="Review workspace tabs"
            className="flex min-w-0 items-center gap-1"
          >
            <div
              role="tab"
              aria-selected="true"
              className="flex h-9 items-center gap-2 rounded-xl bg-[#242426] px-3.5 text-sm font-medium text-zinc-100"
            >
              <FileDiff size={15} />
              Review
            </div>
            <div ref={addMenuRef} className="group relative ml-1">
              <button
                type="button"
                onClick={() => setIsAddMenuOpen((current) => !current)}
                className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
                aria-label="Files"
                aria-haspopup="menu"
                aria-expanded={isAddMenuOpen}
              >
                <Plus size={17} />
              </button>
              <span className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300 opacity-0 shadow-xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                Files
              </span>
              {isAddMenuOpen ? (
                <ReviewAddMenu
                  onToggleFiles={() => {
                    setActiveRail((current) =>
                      current === "files" ? null : "files",
                    );
                    closeAddMenu();
                  }}
                  onToggleChanges={() => {
                    setActiveRail((current) =>
                      current === "changes" ? null : "changes",
                    );
                    closeAddMenu();
                  }}
                />
              ) : null}
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

        <div className="flex min-h-0 flex-1 px-4 pb-4">
          {activeRail === "files" ? (
            <aside className="mt-4 flex w-72 shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-black">
              {filesRail}
            </aside>
          ) : null}
          <div className="min-w-0 flex-1">
            <ChangesPanel
              className="h-full px-4 pb-4"
              mode="modal"
              layout="stacked"
              branch={status?.branch || "No branch"}
              reviewCommentCount={selectedReviewCommentCount}
              onReviewChanges={closeReview}
              isChangesOpen={activeRail === "changes"}
              onToggleChanges={() =>
                setActiveRail((current) =>
                  current === "changes" ? null : "changes",
                )
              }
              isFilesOpen={activeRail === "files"}
              onToggleFiles={() =>
                setActiveRail((current) =>
                  current === "files" ? null : "files",
                )
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewAddMenu({
  onToggleFiles,
  onToggleChanges,
}: {
  onToggleFiles: () => void;
  onToggleChanges: () => void;
}) {
  return (
    <div
      role="menu"
      className="absolute left-0 top-10 z-30 w-44 rounded-lg border border-zinc-800 bg-zinc-950 p-1.5 shadow-2xl"
    >
      <button
        type="button"
        role="menuitem"
        onClick={onToggleFiles}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white"
      >
        <Files size={15} />
        Files
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onToggleChanges}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white"
      >
        <FileChangesIcon size={15} />
        File changes
      </button>
    </div>
  );
}
