import { LoaderCircle } from "lucide-react";
import { ChangesList } from "../diff/ChangesList";
import { DiffViewer } from "../diff/DiffViewer";
import { useGitReview } from "../git/GitReviewContext";

interface ChangesPanelProps {
  className?: string;
  mode?: "sidebar" | "modal";
  onFileSelect?: (path: string) => void;
}

export function ChangesPanel({
  className = "",
  mode = "sidebar",
  onFileSelect,
}: ChangesPanelProps) {
  const {
    status,
    gitAvailable,
    statusLoading,
    statusError,
    diff,
    diffLoading,
    diffError,
    stageError,
    commitError,
    committing,
    selectedFile,
    stagedFiles,
    commitMessage,
    selectedReviewCommentsForFile,
    currentDiffFingerprint,
    addReviewComment,
    deleteReviewComment,
    setCommitMessage,
    openReview,
    selectFile,
    toggleFileStaged,
    stageAll,
    unstageAll,
    submitCommit,
  } = useGitReview();

  const handleSelectFile = (file: NonNullable<typeof selectedFile>) => {
    if (mode === "sidebar") {
      openReview(file.path);
      return;
    }

    selectFile(file);
    onFileSelect?.(file.path);
  };

  const handleCommit = async () => {
    await submitCommit();
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
      <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
        <div
          className={`ui-surface-section flex flex-col overflow-y-auto scrollbar-hide ${
            mode === "sidebar" ? "w-full" : "w-80"
          }`}
        >
          <ChangesList
            files={status?.files || []}
            selectedFile={selectedFile}
            onSelectFile={handleSelectFile}
            stagedFiles={stagedFiles}
            onToggleStaged={toggleFileStaged}
            onStageAll={stageAll}
            onUnstageAll={unstageAll}
          />
        </div>

        {mode === "modal" && (
          <div className="ui-surface-section flex-1 flex flex-col overflow-hidden">
            {selectedFile && diff ? (
              <DiffViewer
                key={`${diff.oldPath}:${diff.newPath}:${diff.hunks.length}`}
                diff={diff}
                className="flex-1 overflow-hidden"
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

      {mode === "sidebar" && (
        <div className="border-t border-zinc-800 pt-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-zinc-400 mb-2">
              Commit Message
            </label>
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Describe your changes..."
              className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
              rows={2}
            />
          </div>

          {(stageError || commitError) && (
            <div className="text-xs text-red-400">{stageError ?? commitError}</div>
          )}

          <button
            onClick={handleCommit}
            disabled={committing || !commitMessage.trim()}
            className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium rounded transition-colors"
          >
            {committing ? "Committing..." : "Commit"}
          </button>
        </div>
      )}
    </div>
  );
}
