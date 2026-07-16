import { useCallback, useMemo } from "react";
import type { DiffContent, FileStatus } from "@repo/shared-types";
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import { buildDiffContentFromTurnDiff } from "../../../services/lifecycle/TurnDiffPatchParser.js";
import { collectLifecycleTurnDiffFiles } from "../../../services/lifecycle/LifecycleTerminalViewModel.js";

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
  const error =
    projection?.terminal && !projection.turnDiff
      ? "Completed-turn review is unavailable because the canonical turn diff was not settled."
      : null;
  const files = useMemo(
    () =>
      projection?.terminal
        ? collectLifecycleTurnDiffFiles(projection)
        : ([] as FileStatus[]),
    [projection],
  );
  const loadFileDiff = useCallback(
    async (file: FileStatus): Promise<DiffContent> => {
      if (!projection?.terminal || !projection.turnDiff) {
        throw new Error("Completed-turn review requires a canonical turn diff.");
      }
      const diff = buildDiffContentFromTurnDiff(projection.turnDiff, file.path);
      if (!diff) {
        throw new Error(`Canonical turn diff is missing ${file.path}`);
      }
      return diff;
    },
    [projection],
  );

  return {
    turnId: projection?.terminal ? projection.turnId : null,
    messageId,
    files,
    loadFileDiff,
    error,
  };
}
