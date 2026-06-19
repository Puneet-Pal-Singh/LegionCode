import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { ChangesPanel } from "../sidebar/ChangesPanel";
import type { SidebarContentTab } from "../layout/workspace/useWorkspaceState";
import { WorkspaceSurfaceBody } from "../layout/workspace/WorkspaceSurfaceBody";
import { WorkspaceSurfaceHeader } from "../layout/workspace/WorkspaceSurfaceHeader";
import { useGitReview } from "./useGitReview";

interface GitReviewDialogProps {
  renderFilesRail?: (onFileOpened: (path: string) => void) => ReactNode;
  contentTabs?: SidebarContentTab[];
  isLoadingContent?: boolean;
  onSelectContent?: (id: string) => void;
  onCloseContent?: (id: string) => void;
  onOpenFilesTab?: () => void;
}

type ReviewRail = "changes" | "files" | null;

export function GitReviewDialog({
  renderFilesRail,
  contentTabs = [],
  isLoadingContent = false,
  onSelectContent,
  onCloseContent,
  onOpenFilesTab,
}: GitReviewDialogProps) {
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
  const [activeRail, setActiveRail] = useState<ReviewRail>(null);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] =
    useState<string>("review");

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

  const activeContentTab = contentTabs.find(
    (tab) => tab.id === activeWorkspaceTabId,
  );
  const openFileTab = (path: string) => {
    setActiveWorkspaceTabId(`file:${path}`);
  };
  const selectWorkspaceTab = (id: string) => {
    setActiveWorkspaceTabId(id);
    if (id !== "review") onSelectContent?.(id);
  };
  const closeWorkspaceTab = (id: string) => {
    onCloseContent?.(id);
    if (activeWorkspaceTabId === id) setActiveWorkspaceTabId("review");
  };
  const toggleFilesWorkspace = () => {
    if (activeWorkspaceTabId === "review") {
      onOpenFilesTab?.();
      setActiveWorkspaceTabId("files");
      setActiveRail("files");
      return;
    }
    setActiveRail((current) => (current === "files" ? null : "files"));
  };

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
        <WorkspaceSurfaceHeader
          variant="fullscreen"
          id={dialogTitleId}
          ariaLabel="Review workspace tabs"
          reviewActive={activeWorkspaceTabId === "review"}
          contentTabs={contentTabs}
          activeContentTabId={activeWorkspaceTabId}
          onSelectReview={() => selectWorkspaceTab("review")}
          onSelectContent={selectWorkspaceTab}
          onCloseContent={closeWorkspaceTab}
          onOpenFiles={toggleFilesWorkspace}
          onOpenChanges={() => {
            setActiveWorkspaceTabId("review");
            setActiveRail((current) =>
              current === "changes" ? null : "changes",
            );
          }}
          addTabLabel="Files"
          trailingActions={
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeReview}
              className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
              aria-label="Close review"
            >
              <X size={16} />
            </button>
          }
        />

        <div className="min-h-0 flex-1">
          <WorkspaceSurfaceBody
            reviewActive={activeWorkspaceTabId === "review"}
            reviewContent={
              <ChangesPanel
                className="h-full"
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
                onToggleFiles={toggleFilesWorkspace}
                filesRail={renderFilesRail?.(openFileTab)}
              />
            }
            selectedFile={
              activeContentTab?.kind === "file" ? activeContentTab : null
            }
            selectedDiff={
              activeContentTab?.kind === "diff" ? activeContentTab : null
            }
            isLoadingContent={isLoadingContent}
            filesOpen={activeRail === "files"}
            onToggleFiles={() =>
              setActiveRail((current) => (current === "files" ? null : "files"))
            }
            filesRail={renderFilesRail?.(openFileTab)}
            railPlacement="inline"
          />
        </div>
      </div>
    </div>
  );
}
