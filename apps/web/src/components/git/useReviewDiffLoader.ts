import { useEffect, useRef } from "react";
import type { DiffContent } from "@repo/shared-types";
import { buildAutoFetchDiffKey } from "./reviewDiffKeys";

interface UseReviewDiffLoaderInput {
  sourceKey: string;
  selectedPath: string | null;
  staged: boolean;
  enabled: boolean;
  diff: DiffContent | null;
  diffLoading: boolean;
  diffError: string | null;
  reviewSourceKind: "live_git" | "prompt_artifact" | "turn_diff";
  fetchLiveDiff: (path: string, staged: boolean) => Promise<void>;
  fetchArtifactDiff: (path: string) => Promise<void>;
  fetchTurnDiff: (path: string) => Promise<void>;
}

export function useReviewDiffLoader({
  sourceKey,
  selectedPath,
  staged,
  enabled,
  diff,
  diffLoading,
  diffError,
  reviewSourceKind,
  fetchLiveDiff,
  fetchArtifactDiff,
  fetchTurnDiff,
}: UseReviewDiffLoaderInput): void {
  const autoFetchedDiffKeyRef = useRef<string | null>(null);

  useEffect(() => {
    autoFetchedDiffKeyRef.current = null;
  }, [sourceKey]);

  useEffect(() => {
    const autoFetchKey = buildAutoFetchDiffKey({
      sourceKey,
      path: selectedPath,
      staged,
    });
    if (
      !enabled ||
      !selectedPath ||
      !autoFetchKey ||
      autoFetchedDiffKeyRef.current === autoFetchKey ||
      diff ||
      diffLoading ||
      diffError
    ) {
      return;
    }

    autoFetchedDiffKeyRef.current = autoFetchKey;
    if (reviewSourceKind === "prompt_artifact") {
      void fetchArtifactDiff(selectedPath);
      return;
    }

    if (reviewSourceKind === "turn_diff") {
      void fetchTurnDiff(selectedPath);
      return;
    }

    void fetchLiveDiff(selectedPath, staged);
  }, [
    diff,
    diffError,
    diffLoading,
    enabled,
    fetchArtifactDiff,
    fetchLiveDiff,
    fetchTurnDiff,
    reviewSourceKind,
    selectedPath,
    sourceKey,
    staged,
  ]);
}
