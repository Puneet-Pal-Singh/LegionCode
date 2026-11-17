import { collectLifecycleTurnDiffFiles } from "@legioncode/sdk";
import { useCallback, useMemo } from "react";
import type { DiffContent, FileStatus } from "@repo/shared-types";
import type { LifecycleProjection } from "@legioncode/sdk";
import { buildDiffContentFromTurnDiff } from "@legioncode/sdk";

export interface CompletedTurnReview {
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly files: FileStatus[];
  readonly loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
  readonly error: string | null;
}

export function useCompletedTurnReview(
  projection: LifecycleProjection | null,
  messageId: string | null,
): CompletedTurnReview {
  const isSettledRepositoryTurn =
    projection?.terminal != null &&
    projection.executionCapability !== "conversation";
  const hasCapturedTurnDiff =
    isSettledRepositoryTurn &&
    projection.workspaceSnapshotState === "captured" &&
    projection.turnDiff?.turnId === projection.turnId;
  const error =
    isSettledRepositoryTurn && !hasCapturedTurnDiff
      ? "Saved changes are unavailable for this reply."
      : null;
  const files = useMemo(
    () =>
      hasCapturedTurnDiff
        ? collectLifecycleTurnDiffFiles(projection)
        : ([] as FileStatus[]),
    [hasCapturedTurnDiff, projection],
  );
  const loadFileDiff = useCallback(
    async (file: FileStatus): Promise<DiffContent> => {
      if (!hasCapturedTurnDiff || !projection?.turnDiff) {
        throw new Error(
          "Settled-turn review requires a captured canonical turn diff.",
        );
      }
      const diff = buildDiffContentFromTurnDiff(projection.turnDiff, file.path);
      if (!diff) {
        throw new Error(`Canonical turn diff is missing ${file.path}`);
      }
      return diff;
    },
    [hasCapturedTurnDiff, projection],
  );

  return {
    turnId: isSettledRepositoryTurn ? projection.turnId : null,
    messageId,
    files,
    loadFileDiff,
    error,
  };
}
