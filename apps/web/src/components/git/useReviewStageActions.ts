import { useCallback, useState } from "react";
import type { FileStatus } from "@repo/shared-types";
import { createGitBranch, pushGitBranch, stageGitFiles } from "../../lib/git-client.js";

interface UseReviewStageActionsInput {
  runId: string | null;
  sessionId: string | null;
  files: FileStatus[];
  stagedFiles: Set<string>;
  selectedFilePath: string | null;
  fetchLiveDiff: (path: string, staged: boolean) => Promise<void>;
  refetch: (force?: boolean) => Promise<void>;
}

export function useReviewStageActions({
  runId,
  sessionId,
  files,
  stagedFiles,
  selectedFilePath,
  fetchLiveDiff,
  refetch,
}: UseReviewStageActionsInput) {
  const [stageError, setStageError] = useState<string | null>(null);
  const updateManyFilesStage = useCallback(
    async (paths: string[], nextStaged: boolean): Promise<boolean> => {
      if (!paths.length) {
        return true;
      }

      if (!runId || !sessionId) {
        setStageError(
          !runId ? "No run context available" : "No session context available",
        );
        return false;
      }

      setStageError(null);

      try {
        await stageGitFiles({
          runId,
          sessionId,
          files: paths,
          unstage: !nextStaged,
        });

        if (selectedFilePath && paths.includes(selectedFilePath)) {
          await fetchLiveDiff(selectedFilePath, nextStaged);
        }

        await refetch(true);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        setStageError(message);
        console.error("[git-review] Failed to update staged files", error);
        return false;
      }
    },
    [fetchLiveDiff, refetch, runId, selectedFilePath, sessionId],
  );
  const toggleFileStaged = useCallback(
    async (path: string, nextStaged: boolean): Promise<void> => {
      await updateManyFilesStage([path], nextStaged);
    },
    [updateManyFilesStage],
  );
  const stageAll = useCallback(async (): Promise<boolean> => {
    return await updateManyFilesStage(
      files.filter((file) => !stagedFiles.has(file.path)).map((file) => file.path),
      true,
    );
  }, [files, stagedFiles, updateManyFilesStage]);
  const unstageAll = useCallback(async (): Promise<boolean> => {
    return await updateManyFilesStage(
      files.filter((file) => stagedFiles.has(file.path)).map((file) => file.path),
      false,
    );
  }, [files, stagedFiles, updateManyFilesStage]);
  const createBranch = useCallback(
    async (branch: string): Promise<string> => {
      if (!runId || !sessionId) {
        throw new Error(
          !runId ? "No run context available" : "No session context available",
        );
      }

      const result = await createGitBranch({ runId, sessionId, payload: { branch } });
      await refetch(true);
      return result.branch;
    },
    [refetch, runId, sessionId],
  );
  const pushBranch = useCallback(
    async (branch?: string): Promise<string> => {
      if (!runId || !sessionId) {
        throw new Error(
          !runId ? "No run context available" : "No session context available",
        );
      }

      const result = await pushGitBranch({ runId, sessionId, payload: { branch } });
      await refetch(true);
      return result.branch;
    },
    [refetch, runId, sessionId],
  );

  return {
    stageError,
    setStageError,
    toggleFileStaged,
    stageAll,
    unstageAll,
    createBranch,
    pushBranch,
  };
}
