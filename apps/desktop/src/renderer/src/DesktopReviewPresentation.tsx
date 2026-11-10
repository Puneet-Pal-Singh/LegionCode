import {
  ChangesList,
  DiffViewer,
  ReviewDiffToolbar,
  ReviewFileStack,
  ReviewPanelLayout,
  useChangesPanelViewState,
  type ReviewScope,
} from "@legioncode/client-ui";
import type { DiffContent, FileStatus } from "@repo/shared-types";
import type { DesktopRightPanelControls } from "./DesktopRightPanel";

export type DesktopReviewSource = Extract<ReviewScope, "turn-diff" | "git-changes">;
export interface DesktopReviewScopeControls {
  value: DesktopReviewSource;
  onChange: (scope: DesktopReviewSource) => void;
  availableScopes: readonly DesktopReviewSource[];
}
type ReviewFile = Omit<FileStatus, "additions" | "deletions"> & {
  additions: number | null;
  deletions: number | null;
};

/** Presentation only; saved Turn and live workspace adapters retain separate read owners. */
export function DesktopReviewPresentation({
  controls,
  scopeControls,
  canonicalTurn = false,
  files = [],
  selectedFile = null,
  onSelectFile = () => {},
  diff = null,
  message,
  error = false,
  onRetry,
  emptyLabel = "No changes",
  missingDiffLabel,
  branch,
}: {
  controls: DesktopRightPanelControls;
  scopeControls?: DesktopReviewScopeControls;
  canonicalTurn?: boolean;
  files?: ReviewFile[];
  selectedFile?: ReviewFile | null;
  onSelectFile?: (file: ReviewFile) => void;
  diff?: DiffContent | null;
  message?: string;
  error?: boolean;
  onRetry?: () => void;
  emptyLabel?: string;
  missingDiffLabel?: string;
  branch?: string;
}) {
  const viewState = useChangesPanelViewState();
  const scope = scopeControls?.value ?? "turn-diff";
  const onScopeChange = (next: ReviewScope) => {
    if (next === "turn-diff" || next === "git-changes") scopeControls?.onChange(next);
  };
  return (
    <ReviewPanelLayout
      mode="modal"
      layout="stacked"
      canonicalTurn={canonicalTurn}
      isChangesOpen={controls.isChangesOpen}
      toolbar={
        <ReviewDiffToolbar
          reviewScope={scope}
          onReviewScopeChange={onScopeChange}
          canonicalAvailable
          availableScopes={scopeControls?.availableScopes ?? ["turn-diff"]}
          branch={branch}
          layout={viewState.diffLayout}
          onLayoutChange={viewState.setDiffLayout}
          wordWrap={viewState.wordWrap}
          onWordWrapChange={viewState.setWordWrap}
          allDiffsCollapsed={viewState.allDiffsCollapsed}
          onToggleAllDiffs={viewState.toggleAllDiffs}
          isChangesOpen={controls.isChangesOpen}
          onToggleChanges={controls.onToggleChanges}
          isFilesOpen={controls.isFilesOpen}
          onToggleFiles={controls.onToggleFiles}
        />
      }
      changesList={
        <ChangesList
          files={files}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          reviewScope={scope}
          onReviewScopeChange={onScopeChange}
          showToolbar={false}
          searchable
          canonicalAvailable
          emptyLabel={message ?? emptyLabel}
        />
      }
    >
      {message ? (
        <div role={error ? "alert" : "status"} className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-zinc-500">
          <p>{message}</p>
          {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
        </div>
      ) : (
        <ReviewFileStack
          files={files}
          selectedFile={selectedFile}
          emptyLabel={emptyLabel}
          onSelectFile={onSelectFile}
          allCollapsed={viewState.allDiffsCollapsed}
        >
          {selectedFile && diff ? (
            <DiffViewer
              key={selectedFile.path}
              diff={diff}
              className="min-h-[420px] w-full overflow-hidden"
              layout={viewState.diffLayout}
              onLayoutChange={viewState.setDiffLayout}
              wordWrap={viewState.wordWrap}
              onWordWrapChange={viewState.setWordWrap}
              showHeader={false}
              showFileSummary={false}
            />
          ) : (
            <p role="status" className="flex flex-1 items-center justify-center p-4 text-sm text-zinc-500">
              {missingDiffLabel ?? emptyLabel}
            </p>
          )}
        </ReviewFileStack>
      )}
    </ReviewPanelLayout>
  );
}
