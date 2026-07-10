import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { DiffContent, FileStatus } from "@repo/shared-types";
import type { ChangedFileDiffState } from "./types";

export function useChangedFileDiffStates(
  files: FileStatus[],
  loadFileDiff: ((file: FileStatus) => Promise<DiffContent>) | undefined,
): Record<string, ChangedFileDiffState> {
  const [diffStates, setDiffStates] = useState<
    Record<string, ChangedFileDiffState>
  >({});

  useEffect(() => {
    if (!loadFileDiff) return;
    let cancelled = false;
    files.forEach((file) => {
      setDiffStateLoading(setDiffStates, file.path);
      void loadFileDiff(file)
        .then((diff) => {
          if (!cancelled) setDiffStateResult(setDiffStates, file.path, diff);
        })
        .catch((error: unknown) => {
          if (!cancelled) setDiffStateError(setDiffStates, file.path, error);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [files, loadFileDiff]);

  return diffStates;
}

function setDiffStateLoading(
  setDiffStates: Dispatch<SetStateAction<Record<string, ChangedFileDiffState>>>,
  path: string,
): void {
  setDiffStates((current) => ({
    ...current,
    [path]: current[path] ?? { loading: true },
  }));
}

function setDiffStateResult(
  setDiffStates: Dispatch<SetStateAction<Record<string, ChangedFileDiffState>>>,
  path: string,
  diff: DiffContent,
): void {
  setDiffStates((current) => ({
    ...current,
    [path]: { loading: false, diff },
  }));
}

function setDiffStateError(
  setDiffStates: Dispatch<SetStateAction<Record<string, ChangedFileDiffState>>>,
  path: string,
  error: unknown,
): void {
  setDiffStates((current) => ({
    ...current,
    [path]: {
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    },
  }));
}
