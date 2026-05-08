import {
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Rows3,
  SquareSplitHorizontal,
} from "lucide-react";
import { useState } from "react";
import { ChangesList } from "../diff/ChangesList";
import { DiffViewer } from "../diff/DiffViewer";
import { useGitReview } from "../git/GitReviewContext";
import { ReviewScopeDropdown } from "../git/ReviewScopeDropdown";
import { cn } from "../../lib/utils";

interface ChangesPanelProps {
  className?: string;
  mode?: "sidebar" | "modal";
  layout?: "side-by-side" | "stacked";
  onFileSelect?: (path: string) => void;
  showToolbar?: boolean;
}

export function ChangesPanel({
  className = "",
  mode = "sidebar",
  layout = "side-by-side",
  onFileSelect,
  showToolbar = true,
}: ChangesPanelProps) {
  const [diffLayout, setDiffLayout] = useState<"stacked" | "split">("stacked");
  const [hunksCollapsed, setHunksCollapsed] = useState(false);
  const [hunkExpansionRequest, setHunkExpansionRequest] = useState<{
    action: "collapse" | "expand";
    id: number;
  }>();
  const {
    status,
    gitAvailable,
    statusLoading,
    statusError,
    diff,
    diffLoading,
    diffError,
    selectedFile,
    reviewScope,
    setReviewScope,
    selectedReviewCommentsForFile,
    currentDiffFingerprint,
    addReviewComment,
    deleteReviewComment,
    selectFile,
  } = useGitReview();

  const handleSelectFile = (file: NonNullable<typeof selectedFile>) => {
    selectFile(file);
    onFileSelect?.(file.path);
  };

  if (statusLoading && !status) {
    return (
      <div
        className={`flex items-center justify-center h-full bg-transparent ${className}`}
      >
        <LoaderCircle className="animate-spin text-zinc-400" size={24} />
      </div>
    );
  }

  if (statusError) {
    return (
      <div className={`p-4 text-red-400 text-sm bg-transparent ${className}`}>
        Error: {statusError}
      </div>
    );
  }

  if (!gitAvailable) {
    return (
      <div className={`p-4 text-zinc-400 text-sm bg-transparent ${className}`}>
        Git is not available for this workspace yet. Connect or initialize a
        repository to use source control actions.
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full gap-4 p-4 bg-transparent ${className}`}>
      {mode === "modal" && showToolbar ? (
        <ReviewDiffToolbar
          reviewScope={reviewScope}
          onReviewScopeChange={setReviewScope}
          layout={diffLayout}
          onLayoutChange={setDiffLayout}
          hunksCollapsed={hunksCollapsed}
          onToggleHunks={() => {
            const nextCollapsed = !hunksCollapsed;
            setHunksCollapsed(nextCollapsed);
            setHunkExpansionRequest({
              action: nextCollapsed ? "collapse" : "expand",
              id: Date.now(),
            });
          }}
        />
      ) : null}
      <div
        className={`flex-1 flex min-h-0 overflow-hidden ${
          mode === "modal" && layout === "stacked"
            ? "flex-col gap-3"
            : "gap-4"
        }`}
      >
        <div
          className={`ui-surface-section flex flex-col overflow-y-auto scrollbar-hide ${
            mode === "sidebar"
              ? "w-full"
              : layout === "stacked"
                ? "max-h-64 min-h-36"
                : "w-80"
          }`}
        >
          <ChangesList
            files={status?.files || []}
            selectedFile={selectedFile}
            onSelectFile={handleSelectFile}
            reviewScope={reviewScope}
            onReviewScopeChange={setReviewScope}
            showToolbar={mode === "sidebar" ? showToolbar : false}
          />
        </div>

        {mode === "modal" && (
          <div className="ui-surface-section flex-1 flex flex-col overflow-hidden">
            {selectedFile && diff ? (
              <DiffViewer
                key={`${diff.oldPath}:${diff.newPath}:${diff.hunks.length}`}
                diff={diff}
                className="flex-1 overflow-hidden"
                layout={diffLayout}
                onLayoutChange={setDiffLayout}
                showHeader={false}
                hunkExpansionRequest={hunkExpansionRequest}
                reviewComments={selectedReviewCommentsForFile}
                diffFingerprint={currentDiffFingerprint}
                onCreateReviewComment={addReviewComment}
                onDeleteReviewComment={deleteReviewComment}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
                {selectedFile
                  ? diffLoading
                    ? "Loading diff..."
                    : diffError ?? "No diff available"
                  : "Select a file to view changes"}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewDiffToolbar({
  reviewScope,
  onReviewScopeChange,
  layout,
  onLayoutChange,
  hunksCollapsed,
  onToggleHunks,
}: {
  reviewScope: "git-changes";
  onReviewScopeChange: (scope: "git-changes") => void;
  layout: "stacked" | "split";
  onLayoutChange: (layout: "stacked" | "split") => void;
  hunksCollapsed: boolean;
  onToggleHunks: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
      <ReviewScopeDropdown
        value={reviewScope}
        onChange={onReviewScopeChange}
      />
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => onLayoutChange("stacked")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors",
              layout === "stacked"
                ? "bg-zinc-800 text-white"
                : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            <Rows3 size={13} />
            Unified
          </button>
          <button
            type="button"
            onClick={() => onLayoutChange("split")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors",
              layout === "split"
                ? "bg-zinc-800 text-white"
                : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            <SquareSplitHorizontal size={13} />
            Split
          </button>
        </div>
        <button
          type="button"
          onClick={onToggleHunks}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white"
        >
          {hunksCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          {hunksCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>
    </div>
  );
}
