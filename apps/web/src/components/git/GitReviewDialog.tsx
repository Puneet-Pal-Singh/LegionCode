import { useEffect, useState, type ReactNode } from "react";
import {
  ReviewDialogFrame,
  ReviewDialogCloseButton,
} from "@legioncode/client-ui";
import { ChangesPanel } from "../sidebar/ChangesPanel";
import type { SidebarContentTab } from "../layout/workspace/useWorkspaceState";
import { WorkspaceSurfaceBody } from "../layout/workspace/WorkspaceSurfaceBody";
import { WorkspaceSurfaceHeader } from "../layout/workspace/WorkspaceSurfaceHeader";
import { useGitReview } from "./useGitReview";

interface GitReviewDialogProps {
  renderFilesRail?: (onFileOpened: (path: string) => void) => ReactNode;
  contentTabs?: SidebarContentTab[];
  isLoadingContent?: boolean;
  contentError?: string | null;
  onSelectContent?: (id: string) => void;
  onCloseContent?: (id: string) => void;
  onOpenFilesTab?: () => void;
}

type ReviewRail = "changes" | "files" | null;

export function GitReviewDialog({
  renderFilesRail,
  contentTabs = [],
  isLoadingContent = false,
  contentError,
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
  const [activeRail, setActiveRail] = useState<ReviewRail>("changes");
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] =
    useState<string>("review");

  useEffect(() => {
    if (!isReviewOpen || selectedFile || reviewFiles.length === 0) {
      return;
    }

    const [firstFile] = reviewFiles;
    if (firstFile) {
      selectFile(firstFile);
    }
  }, [isReviewOpen, reviewFiles, selectFile, selectedFile]);

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
    <ReviewDialogFrame isOpen={isReviewOpen} onClose={closeReview}>
      {({ titleId, closeButtonRef }) => (
        <>
          <WorkspaceSurfaceHeader
            variant="fullscreen"
            id={titleId}
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
              <ReviewDialogCloseButton
                buttonRef={closeButtonRef}
                onClose={closeReview}
              />
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
              contentError={contentError}
              filesOpen={activeRail === "files"}
              onToggleFiles={() =>
                setActiveRail((current) =>
                  current === "files" ? null : "files",
                )
              }
              filesRail={renderFilesRail?.(openFileTab)}
              railPlacement="inline"
            />
          </div>
        </>
      )}
    </ReviewDialogFrame>
  );
}
