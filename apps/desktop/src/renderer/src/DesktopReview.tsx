import {
  ChangesList,
  DiffViewer,
  ReviewDiffToolbar,
  ReviewFileStack,
  ReviewPanelLayout,
  useChangesPanelViewState,
} from "@legioncode/client-ui";
import type { DesktopRightPanelControls } from "./DesktopRightPanel";
import {
  buildDiffContentFromTurnDiff,
  type AppServerClient,
  type LifecycleProjection,
} from "@legioncode/sdk";
import type {
  ThreadId,
  TurnDiffPayload,
  TurnId,
  WorkspaceId,
} from "@repo/platform-protocol";
import type { FileStatus } from "@repo/shared-types";
import { useEffect, useState } from "react";

export interface DesktopReviewSelection {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  turnId: TurnId;
  terminalState: NonNullable<LifecycleProjection["terminal"]>["state"];
}

export interface DesktopReviewProps {
  client: Pick<AppServerClient, "getTurnDiff">;
  selection: DesktopReviewSelection | null;
  scope: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    grantGrantedAt: string;
  } | null;
  availability: { available: true } | { available: false; reason: string };
  controls: DesktopRightPanelControls;
}

type ReviewRead = { client: DesktopReviewProps["client"] } & (
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; diff: TurnDiffPayload | null }
);

/** Parent supplies a replay-settled selection, actual grant scope and advertised capability. */
export function DesktopReview({
  client,
  selection,
  scope,
  availability,
  controls,
}: DesktopReviewProps) {
  if (!scope)
    return (
      <ReviewStatus
        controls={controls}
        message="Open a granted workspace and thread to review saved changes."
      />
    );
  if (
    selection &&
    (selection.workspaceId !== scope.workspaceId ||
      selection.threadId !== scope.threadId)
  ) {
    return (
      <ReviewStatus
        controls={controls}
        message="Select a settled turn in the current workspace and thread."
      />
    );
  }
  if (!availability.available)
    return (
      <ReviewStatus
        controls={controls}
        message={`Saved turn review unavailable: ${availability.reason}`}
      />
    );
  if (!selection)
    return (
      <ReviewStatus
        controls={controls}
        message="Select a settled turn to review."
      />
    );
  return (
    <SelectedTurnReview
      key={JSON.stringify([
        scope.grantGrantedAt,
        selection.workspaceId,
        selection.threadId,
        selection.turnId,
        selection.terminalState,
      ])}
      client={client}
      turnId={selection.turnId}
      controls={controls}
    />
  );
}

function SelectedTurnReview({
  client,
  turnId,
  controls,
}: {
  client: DesktopReviewProps["client"];
  turnId: TurnId;
  controls: DesktopRightPanelControls;
}) {
  const viewState = useChangesPanelViewState();
  const isChangesOpen = controls.isChangesOpen;
  const onToggleChanges = controls.onToggleChanges;
  const [read, setRead] = useState<ReviewRead>({ client, status: "loading" });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setRead({ client, status: "loading" });
    void client
      .getTurnDiff({ turnId })
      .then(({ diff }) => {
        if (!active) return;
        if (diff && diff.turnId !== turnId) {
          setRead({ client, status: "error" });
          return;
        }
        setRead({ client, status: "ready", diff });
      })
      .catch(() => {
        if (active) setRead({ client, status: "error" });
      });
    return () => {
      active = false;
    };
  }, [client, turnId, request]);

  if (read.client !== client || read.status === "loading")
    return (
      <ReviewStatus controls={controls} message="Loading saved turn changes…" />
    );
  if (read.status === "error")
    return (
      <div role="alert">
        <p>Saved turn changes could not be loaded.</p>
        <button type="button" onClick={() => setRequest((value) => value + 1)}>
          Retry
        </button>
      </div>
    );
  if (!read.diff)
    return (
      <ReviewStatus
        controls={controls}
        message="No saved diff is available for this turn."
      />
    );

  const savedDiff = read.diff;
  const files = savedDiff.files.map((file) => {
    const status: FileStatus["status"] =
      file.status === "copied" || file.status === "unchanged"
        ? "modified"
        : file.status;
    return {
      path: file.path,
      status,
      additions: file.additions,
      deletions: file.deletions,
      isStaged: false,
    };
  });
  const selectedFile =
    files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const diff = selectedFile
    ? buildDiffContentFromTurnDiff(savedDiff, selectedFile.path)
    : null;

  return (
    <ReviewPanelLayout
      mode="modal"
      layout="stacked"
      canonicalTurn
      isChangesOpen={isChangesOpen}
      toolbar={
        <ReviewDiffToolbar
          reviewScope="turn-diff"
          onReviewScopeChange={() => {}}
          canonicalAvailable
          availableScopes={["turn-diff"]}
          layout={viewState.diffLayout}
          onLayoutChange={viewState.setDiffLayout}
          wordWrap={viewState.wordWrap}
          onWordWrapChange={viewState.setWordWrap}
          allDiffsCollapsed={viewState.allDiffsCollapsed}
          onToggleAllDiffs={viewState.toggleAllDiffs}
          isChangesOpen={isChangesOpen}
          onToggleChanges={onToggleChanges}
          isFilesOpen={controls.isFilesOpen}
          onToggleFiles={controls.onToggleFiles}
        />
      }
      changesList={
        <ChangesList
          files={files}
          selectedFile={selectedFile}
          onSelectFile={(file) => setSelectedPath(file.path)}
          reviewScope="turn-diff"
          onReviewScopeChange={() => {}}
          showToolbar={false}
          searchable
          canonicalAvailable
          emptyLabel="No changes in this saved turn."
        />
      }
    >
      <ReviewFileStack
        files={files}
        selectedFile={selectedFile}
        emptyLabel="No changes in this saved turn."
        onSelectFile={(file) => setSelectedPath(file.path)}
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
          <p
            role="status"
            className="flex flex-1 items-center justify-center text-sm text-zinc-500"
          >
            {selectedFile
              ? `Saved patch content is unavailable for ${selectedFile.path}.`
              : "No changes in this saved turn."}
          </p>
        )}
      </ReviewFileStack>
    </ReviewPanelLayout>
  );
}

function ReviewStatus({
  message,
  controls,
}: {
  message: string;
  controls: DesktopRightPanelControls;
}) {
  const viewState = useChangesPanelViewState();
  const isChangesOpen = controls.isChangesOpen;
  return (
    <ReviewPanelLayout
      mode="modal"
      layout="stacked"
      isChangesOpen={isChangesOpen}
      changesList={
        <p role="status" className="p-4 text-sm text-zinc-500">
          {message}
        </p>
      }
      toolbar={
        <ReviewDiffToolbar
          reviewScope="turn-diff"
          onReviewScopeChange={() => {}}
          availableScopes={["turn-diff"]}
          layout={viewState.diffLayout}
          onLayoutChange={viewState.setDiffLayout}
          wordWrap={viewState.wordWrap}
          onWordWrapChange={viewState.setWordWrap}
          allDiffsCollapsed={viewState.allDiffsCollapsed}
          onToggleAllDiffs={viewState.toggleAllDiffs}
          isChangesOpen={isChangesOpen}
          onToggleChanges={controls.onToggleChanges}
          isFilesOpen={controls.isFilesOpen}
          onToggleFiles={controls.onToggleFiles}
        />
      }
    >
      <p
        role="status"
        className="flex flex-1 items-center justify-center p-4 text-sm text-zinc-500"
      >
        {message}
      </p>
    </ReviewPanelLayout>
  );
}
