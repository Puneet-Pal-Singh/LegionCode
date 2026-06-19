import { useEffect, useMemo, type ReactNode } from "react";
import { ChangesList } from "../diff/ChangesList";
import { DiffViewer } from "../diff/DiffViewer";
import { useGitReview } from "../git/useGitReview";
import { REVIEW_SOURCE_LABELS } from "../../services/review/ReviewSourceResolver";
import { getDiffMessage, getEmptyReviewLabel } from "./changesPanelMessages";
import {
  GitUnavailableState,
  ReviewDiffPlaceholder,
  ReviewErrorState,
  ReviewLoadingState,
} from "./ReviewEmptyState";
import { ReviewDiffToolbar } from "./ReviewDiffToolbar";
import { ReviewFileStack } from "./ReviewFileStack";
import { useChangesPanelViewState } from "./useChangesPanelViewState";

interface ChangesPanelProps {
  className?: string;
  mode?: "sidebar" | "modal";
  layout?: "side-by-side" | "stacked";
  onFileSelect?: (path: string) => void;
  showToolbar?: boolean;
  isChangesOpen?: boolean;
  onToggleChanges?: () => void;
  branch?: string;
  reviewCommentCount?: number;
  onReviewChanges?: () => void;
  isFilesOpen?: boolean;
  onToggleFiles?: () => void;
  filesRail?: ReactNode;
  showChangesRail?: boolean;
}

export function ChangesPanel({
  className = "",
  mode = "sidebar",
  layout = "side-by-side",
  onFileSelect,
  showToolbar = true,
  isChangesOpen = false,
  onToggleChanges = () => undefined,
  branch,
  reviewCommentCount = 0,
  onReviewChanges,
  isFilesOpen = false,
  onToggleFiles,
  filesRail,
  showChangesRail = true,
}: ChangesPanelProps) {
  const viewState = useChangesPanelViewState();
  const review = useGitReview();
  const files = useMemo(() => review.reviewFiles, [review.reviewFiles]);
  const isSavedEditMode = review.reviewSource.kind === "prompt_artifact";
  const showStackedReview = layout === "stacked";
  const showChangesList =
    showChangesRail &&
    (!showStackedReview || (mode === "modal" && isChangesOpen));
  const emptyReviewLabel = getEmptyReviewLabel({
    isSavedEditMode,
    reviewScope: review.reviewScope,
    reviewSourceReason: review.reviewSource.reason,
    reviewSourceLoading: review.reviewSourceLoading,
    reviewSourceError: review.reviewSourceError,
  });
  const diffMessage = getDiffMessage({
    selectedFile: review.selectedFile,
    diffLoading: review.diffLoading,
    diffError: review.diffError,
    hasFiles: files.length > 0,
    emptyReviewLabel,
  });

  useEffect(() => {
    if (review.selectedFile || files.length === 0) {
      return;
    }

    const [firstFile] = files;
    if (firstFile) {
      review.selectFile(firstFile);
    }
  }, [files, review]);

  if (
    !isSavedEditMode &&
    (review.statusLoading || review.isGitWorkspaceRecovering) &&
    !review.status
  ) {
    return (
      <ReviewLoadingState
        className={className}
        isGitWorkspaceRecovering={review.isGitWorkspaceRecovering}
      />
    );
  }

  if (!isSavedEditMode && review.statusError && !review.status) {
    return (
      <ReviewErrorState className={className} message={review.statusError} />
    );
  }

  if (!isSavedEditMode && !review.gitAvailable) {
    return (
      <GitUnavailableState
        className={className}
        isGitWorkspaceRecovering={
          review.statusLoading || review.isGitWorkspaceRecovering
        }
      />
    );
  }

  return (
    <div
      className={`flex h-full min-h-0 flex-col overflow-visible bg-transparent ${
        mode === "modal"
          ? "p-0"
          : showStackedReview
            ? "gap-4 py-4"
            : "gap-4 p-4"
      } ${className}`}
    >
      {mode === "modal" && showToolbar ? (
        <ReviewDiffToolbar
          reviewScope={review.reviewScope}
          onReviewScopeChange={review.setReviewScope}
          layout={viewState.diffLayout}
          onLayoutChange={viewState.setDiffLayout}
          wordWrap={viewState.wordWrap}
          onWordWrapChange={viewState.setWordWrap}
          allDiffsCollapsed={viewState.allDiffsCollapsed}
          onToggleAllDiffs={viewState.toggleAllDiffs}
          isChangesOpen={isChangesOpen}
          onToggleChanges={onToggleChanges}
          branch={branch}
          reviewCommentCount={reviewCommentCount}
          onReviewChanges={onReviewChanges}
          isFilesOpen={isFilesOpen}
          onToggleFiles={onToggleFiles}
        />
      ) : null}
      <div
        className={`flex min-h-0 flex-1 overflow-hidden ${
          mode === "sidebar" ||
          (mode === "modal" && layout === "stacked" && !isChangesOpen)
            ? isFilesOpen
              ? ""
              : "flex-col gap-3"
            : ""
        }`}
      >
        {mode === "modal" && isFilesOpen ? (
          <aside className="flex w-72 shrink-0 overflow-hidden border-r border-zinc-800 bg-black">
            {filesRail}
          </aside>
        ) : null}
        {showChangesList ? (
          <div
            className={`ui-surface-section flex flex-col overflow-y-auto scrollbar-hide ${
              mode === "sidebar"
                ? "max-h-56 w-full shrink-0"
                : "w-72 shrink-0 rounded-none border-y-0 border-l-0"
            }`}
          >
            <ChangesList
              files={files}
              selectedFile={review.selectedFile}
              onSelectFile={(file) => {
                review.selectFile(file);
                onFileSelect?.(file.path);
              }}
              reviewScope={review.reviewScope}
              onReviewScopeChange={review.setReviewScope}
              showToolbar={mode === "sidebar" ? showToolbar : false}
              sourceBadgeLabel={
                review.reviewScope === "prompt-artifact"
                  ? REVIEW_SOURCE_LABELS.prompt_artifact.badge
                  : REVIEW_SOURCE_LABELS.live_git.badge
              }
              emptyLabel={emptyReviewLabel}
            />
          </div>
        ) : null}

        {showStackedReview ? (
          <ReviewFileStack
            files={files}
            selectedFile={review.selectedFile}
            emptyLabel={emptyReviewLabel}
            onSelectFile={(file) => {
              review.selectFile(file);
              onFileSelect?.(file.path);
            }}
            allCollapsed={viewState.allDiffsCollapsed}
          >
            <ReviewDiffContent
              review={review}
              viewState={viewState}
              diffMessage={diffMessage}
              showFileSummary={false}
            />
          </ReviewFileStack>
        ) : mode === "modal" || mode === "sidebar" ? (
          <div className="ui-surface-section flex flex-1 flex-col overflow-hidden">
            <ReviewDiffContent
              review={review}
              viewState={viewState}
              diffMessage={diffMessage}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReviewDiffContent({
  review,
  viewState,
  diffMessage,
  showFileSummary = true,
}: {
  review: ReturnType<typeof useGitReview>;
  viewState: ReturnType<typeof useChangesPanelViewState>;
  diffMessage: string;
  showFileSummary?: boolean;
}) {
  if (!review.selectedFile || !review.diff) {
    return <ReviewDiffPlaceholder message={diffMessage} />;
  }

  return (
    <DiffViewer
      key={`${review.diff.oldPath}:${review.diff.newPath}:${review.diff.hunks.length}`}
      diff={review.diff}
      className="min-h-[420px] w-full overflow-hidden"
      layout={viewState.diffLayout}
      onLayoutChange={viewState.setDiffLayout}
      wordWrap={viewState.wordWrap}
      onWordWrapChange={viewState.setWordWrap}
      showHeader={false}
      showFileSummary={showFileSummary}
      reviewComments={review.selectedReviewCommentsForFile}
      diffFingerprint={review.currentDiffFingerprint}
      onCreateReviewComment={review.addReviewComment}
      onDeleteReviewComment={review.deleteReviewComment}
    />
  );
}
