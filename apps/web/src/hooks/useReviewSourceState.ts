import { useCallback, useMemo, useState } from "react";
import type {
  EditArtifactIdentity,
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import { useEditArtifactDiff } from "./useEditArtifactDiff";
import { useEditArtifactReviewSource } from "./useEditArtifactReviewSource";
import {
  resolveReviewSource,
  type OpenedReviewArtifact,
  type ReviewScope,
  type CanonicalTurnReviewSource,
} from "../services/review/ReviewSourceResolver";

interface UseReviewSourceStateInput {
  runId?: string;
  sessionId?: string;
  liveGitFiles: FileStatus[];
  canonicalTurnReview?: CanonicalTurnReviewSource | null;
  enabled?: boolean;
  artifactIdentity?: EditArtifactIdentity | null;
}

export function useReviewSourceState({
  runId,
  sessionId,
  liveGitFiles,
  canonicalTurnReview = null,
  enabled = true,
  artifactIdentity = null,
}: UseReviewSourceStateInput) {
  const reviewTargetKey = `${runId ?? ""}:${sessionId ?? ""}`;
  const [requestedScopeState, setRequestedScopeState] =
    useState<ScopedReviewScope>(() => ({
      key: reviewTargetKey,
      scope: null,
    }));
  const [openedArtifactState, setOpenedArtifactState] =
    useState<ScopedOpenedArtifact>(() => ({
      artifact: null,
      key: reviewTargetKey,
    }));
  const requestedScope =
    requestedScopeState.key === reviewTargetKey
      ? requestedScopeState.scope
      : null;
  const openedArtifact =
    openedArtifactState.key === reviewTargetKey
      ? openedArtifactState.artifact
      : null;
  const setRequestedScope = useCallback(
    (scope: ReviewScope): void => {
      setRequestedScopeState({ key: reviewTargetKey, scope });
    },
    [reviewTargetKey],
  );
  const setOpenedArtifact = useCallback(
    (artifact: OpenedReviewArtifact | null): void => {
      setOpenedArtifactState({ artifact, key: reviewTargetKey });
    },
    [reviewTargetKey],
  );

  const shouldLoadArtifactSource = Boolean(
    enabled &&
    runId &&
    requestedScope !== "git-changes" &&
    requestedScope !== "turn-diff" &&
    (requestedScope === "prompt-artifact" || openedArtifact),
  );
  const {
    source: promptArtifactSource,
    loading: artifactSourceLoading,
    error: artifactSourceError,
    resolved: artifactSourceResolved,
  } = useEditArtifactReviewSource({
    runId,
    sessionId,
    assistantMessageId: openedArtifact?.assistantMessageId,
    identity: openedArtifact?.identity ?? artifactIdentity,
    enabled: shouldLoadArtifactSource,
  });
  const reviewSource = useMemo(
    () =>
      resolveReviewSource({
        requestedScope,
        openedArtifact,
        liveGitFiles,
        latestArtifactSource: promptArtifactSource,
        canonicalTurnReview,
      }),
    [
      canonicalTurnReview,
      liveGitFiles,
      openedArtifact,
      promptArtifactSource,
      requestedScope,
    ],
  );
  const selectedArtifactId =
    reviewSource.kind === "prompt_artifact"
      ? reviewSource.artifactId
      : undefined;
  const artifactDiffState = useEditArtifactDiff(
    selectedArtifactId,
    reviewSource.kind === "prompt_artifact"
      ? (reviewSource.identity ?? artifactIdentity)
      : artifactIdentity,
  );
  const reviewScope = requestedScope ?? sourceKindToScope(reviewSource.kind);
  const reviewSourceLoading =
    shouldLoadArtifactSource &&
    (artifactSourceLoading || !artifactSourceResolved);
  const controls = useReviewSourceControls({
    promptArtifactSource,
    reviewSource,
    setOpenedArtifact,
    setRequestedScope,
  });

  return {
    artifactDiffState,
    promptArtifactSource,
    reviewScope,
    reviewSource,
    reviewSourceError: shouldLoadArtifactSource ? artifactSourceError : null,
    reviewSourceLoading,
    ...controls,
  };
}

interface ScopedReviewScope {
  key: string;
  scope: ReviewScope | null;
}

interface ScopedOpenedArtifact {
  artifact: OpenedReviewArtifact | null;
  key: string;
}

function useReviewSourceControls({
  promptArtifactSource,
  reviewSource,
  setOpenedArtifact,
  setRequestedScope,
}: {
  promptArtifactSource: PromptArtifactReviewSource | null;
  reviewSource: ReturnType<typeof resolveReviewSource>;
  setOpenedArtifact: (artifact: OpenedReviewArtifact | null) => void;
  setRequestedScope: (scope: ReviewScope) => void;
}) {
  const openLiveGitReviewSource = useCallback(() => {
    setRequestedScope("git-changes");
    setOpenedArtifact(null);
  }, [setOpenedArtifact, setRequestedScope]);

  const openPromptArtifactReviewSource = useCallback(
    (
      artifactId: string,
      assistantMessageId?: string,
      identity?: EditArtifactIdentity,
    ) => {
      setRequestedScope("prompt-artifact");
      setOpenedArtifact({ artifactId, assistantMessageId, identity });
    },
    [setOpenedArtifact, setRequestedScope],
  );

  const selectReviewScope = useCallback(
    (scope: ReviewScope) => {
      setRequestedScope(scope);
      setOpenedArtifact(
        resolveOpenedArtifact(scope, reviewSource, promptArtifactSource),
      );
    },
    [promptArtifactSource, reviewSource, setOpenedArtifact, setRequestedScope],
  );

  return {
    openLiveGitReviewSource,
    openPromptArtifactReviewSource,
    selectReviewScope,
  };
}

function resolveOpenedArtifact(
  scope: ReviewScope,
  reviewSource: ReturnType<typeof resolveReviewSource>,
  promptArtifactSource: PromptArtifactReviewSource | null,
): OpenedReviewArtifact | null {
  if (scope === "git-changes" || scope === "turn-diff") {
    return null;
  }

  if (reviewSource.kind === "prompt_artifact") {
    return {
      artifactId: reviewSource.artifactId,
      assistantMessageId: reviewSource.assistantMessageId,
      identity: reviewSource.identity,
    };
  }

  return promptArtifactSource
    ? {
        artifactId: promptArtifactSource.artifactId,
        assistantMessageId: promptArtifactSource.assistantMessageId,
        identity: {
          threadId: promptArtifactSource.threadId,
          turnId: promptArtifactSource.turnId,
          runAttemptId: promptArtifactSource.runAttemptId,
          workspaceId: promptArtifactSource.workspaceId,
        },
      }
    : null;
}

function sourceKindToScope(
  kind: "live_git" | "prompt_artifact" | "turn_diff",
): ReviewScope {
  if (kind === "prompt_artifact") return "prompt-artifact";
  if (kind === "turn_diff") return "turn-diff";
  return "git-changes";
}
