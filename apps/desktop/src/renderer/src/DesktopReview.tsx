import type { DesktopRightPanelControls } from "./DesktopRightPanel";
import {
  buildDiffContentFromTurnDiff,
  type LifecycleProjection,
} from "@legioncode/sdk";
import type {
  ThreadId,
  TurnId,
  WorkspaceId,
} from "@repo/platform-protocol";
import { useState } from "react";
import { DesktopReviewPresentation, type DesktopReviewScopeControls } from "./DesktopReviewPresentation";
import type { DesktopSavedReviewRead } from "./useDesktopSavedReviewSelection";

export interface DesktopReviewSelection {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  turnId: TurnId;
  terminalState: NonNullable<LifecycleProjection["terminal"]>["state"];
}

export interface DesktopReviewProps {
  read: DesktopSavedReviewRead;
  onRetry: () => void;
  selection: DesktopReviewSelection | null;
  scope: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    grantGrantedAt: string;
  } | null;
  availability: { available: true } | { available: false; reason: string };
  controls: DesktopRightPanelControls;
  scopeControls?: DesktopReviewScopeControls;
}

/** Parent supplies a replay-settled selection, actual grant scope and advertised capability. */
export function DesktopReview({
  read,
  onRetry,
  selection,
  scope,
  availability,
  controls,
  scopeControls,
}: DesktopReviewProps) {
  if (!scope)
    return (
      <ReviewStatus
        controls={controls}
        scopeControls={scopeControls}
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
        scopeControls={scopeControls}
        message="Select a settled turn in the current workspace and thread."
      />
    );
  }
  if (!availability.available)
    return (
      <ReviewStatus
        controls={controls}
        scopeControls={scopeControls}
        message={`Saved turn review unavailable: ${availability.reason}`}
      />
    );
  if (!selection)
    return (
      <ReviewStatus
        controls={controls}
        scopeControls={scopeControls}
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
      read={read}
      onRetry={onRetry}
      controls={controls}
      scopeControls={scopeControls}
    />
  );
}

function SelectedTurnReview({
  read,
  onRetry,
  controls,
  scopeControls,
}: Pick<DesktopReviewProps, "read" | "onRetry" | "controls" | "scopeControls">) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const savedDiff = read.status === "ready" ? read.diff : null;
  const files = savedDiff?.files.map((file) => ({
    path: file.path,
    status: file.status === "copied" || file.status === "unchanged"
      ? "modified" as const : file.status,
    additions: file.additions,
    deletions: file.deletions,
    isStaged: false,
  })) ?? [];
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const message = read.status === "idle" || read.status === "loading"
    ? "Loading saved turn changes…"
    : read.status === "error" ? "Saved turn changes could not be loaded."
      : !savedDiff ? "No saved diff is available for this turn." : undefined;
  return (
    <DesktopReviewPresentation
      controls={controls}
      scopeControls={scopeControls}
      canonicalTurn
      files={files}
      selectedFile={selectedFile}
      onSelectFile={(file) => setSelectedPath(file.path)}
      diff={savedDiff && selectedFile ? buildDiffContentFromTurnDiff(savedDiff, selectedFile.path) : null}
      message={message}
      error={read.status === "error"}
      onRetry={read.status === "error" ? onRetry : undefined}
      emptyLabel="No changes in this saved turn."
      missingDiffLabel={selectedFile ? `Saved patch content is unavailable for ${selectedFile.path}.` : undefined}
    />
  );
}

function ReviewStatus({ message, controls, scopeControls }: {
  message: string;
  controls: DesktopRightPanelControls;
  scopeControls?: DesktopReviewScopeControls;
}) {
  return <DesktopReviewPresentation controls={controls} scopeControls={scopeControls} message={message} />;
}
