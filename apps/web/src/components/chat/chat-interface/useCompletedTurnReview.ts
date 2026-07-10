import { useCallback, useMemo } from "react";
import type { DiffContent, FileStatus } from "@repo/shared-types";
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import { buildDiffContentFromTurnDiff } from "../../../services/lifecycle/TurnDiffPatchParser.js";
import { collectLifecycleTurnDiffFiles } from "../../../services/lifecycle/LifecycleTerminalViewModel.js";

export function useCompletedTurnReview(
  projection: LifecycleProjection | null,
) {
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

  return { files, loadFileDiff };
}
