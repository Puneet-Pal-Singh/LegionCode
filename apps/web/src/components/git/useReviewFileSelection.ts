import { useCallback, useMemo, useState } from "react";
import type { FileStatus } from "@repo/shared-types";

interface UseReviewFileSelectionInput {
  files: FileStatus[];
  stagedFiles: Set<string>;
  reviewSourceKind: "live_git" | "prompt_artifact";
  fetchLiveDiff: (path: string, staged: boolean) => Promise<void>;
  fetchArtifactDiff: (path: string) => Promise<void>;
}

export function useReviewFileSelection({
  files,
  stagedFiles,
  reviewSourceKind,
  fetchLiveDiff,
  fetchArtifactDiff,
}: UseReviewFileSelectionInput) {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const activeSelectedFilePath = selectedFilePath ?? files[0]?.path ?? null;
  const selectedFile = useMemo(() => {
    if (!activeSelectedFilePath) {
      return null;
    }

    return files.find((file) => file.path === activeSelectedFilePath) ?? null;
  }, [activeSelectedFilePath, files]);

  const selectFilePath = useCallback(
    async (path: string, staged: boolean): Promise<void> => {
      setSelectedFilePath(path);
      if (reviewSourceKind === "prompt_artifact") {
        await fetchArtifactDiff(path);
        return;
      }

      await fetchLiveDiff(path, staged);
    },
    [fetchArtifactDiff, fetchLiveDiff, reviewSourceKind],
  );

  const selectFile = useCallback(
    (file: FileStatus): void => {
      void selectFilePath(file.path, file.isStaged);
    },
    [selectFilePath],
  );

  const selectFirstFile = useCallback((): void => {
    if (selectedFilePath) {
      return;
    }

    const [firstFile] = files;
    if (firstFile) {
      void selectFilePath(firstFile.path, stagedFiles.has(firstFile.path));
    }
  }, [files, selectFilePath, selectedFilePath, stagedFiles]);

  return {
    activeSelectedFilePath,
    selectedFile,
    selectedFilePath,
    setSelectedFilePath,
    selectFile,
    selectFilePath,
    selectFirstFile,
  };
}
