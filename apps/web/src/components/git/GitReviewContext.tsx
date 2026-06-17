import { useCallback, useMemo, useState } from "react";
import { useRunContext } from "../../hooks/useRunContext";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitDiff } from "../../hooks/useGitDiff";
import { useReviewSourceState } from "../../hooks/useReviewSourceState";
import { useGitCommit } from "../../hooks/useGitCommit";
import { EMPTY_FILE_STATUSES } from "../../lib/empty-collections";
import { buildDiffFingerprint } from "./reviewComments";
import {
  GitReviewContext,
  type GitReviewContextValue,
  type GitReviewProviderProps,
} from "./GitReviewContextValue";
import { buildReviewDiffSourceKey } from "./reviewDiffKeys";
import {
  collectStagedFilePaths,
  generateCommitMessage,
  mapArtifactFilesToStatus,
} from "./reviewFileMappers";
import { useReviewCommentsState } from "./useReviewCommentsState";
import { useReviewDiffLoader } from "./useReviewDiffLoader";
import { useReviewFileSelection } from "./useReviewFileSelection";
import { useReviewStageActions } from "./useReviewStageActions";

export function GitReviewProvider({
  children,
  isReviewOpen,
  onReviewOpenChange,
  isReviewActive = false,
  isGitWorkspaceRecovering = false,
}: GitReviewProviderProps) {
  const { runId, sessionId } = useRunContext();
  const shouldLoadReviewData = isReviewOpen || isReviewActive;
  const {
    status,
    gitAvailable,
    loading: statusLoading,
    error: statusError,
    refetch,
  } = useGitStatus(
    runId ?? undefined,
    sessionId ?? undefined,
    shouldLoadReviewData,
  );
  const {
    diff: liveDiff,
    loading: liveDiffLoading,
    error: liveDiffError,
    fetch: fetchLiveDiff,
  } = useGitDiff(runId ?? undefined, sessionId ?? undefined);
  const {
    committing,
    error: commitError,
    errorState: commitErrorState,
    commit,
  } = useGitCommit(runId ?? undefined, sessionId ?? undefined);
  const [commitMessage, setCommitMessage] = useState("");
  const liveGitFiles = status?.files ?? EMPTY_FILE_STATUSES;
  const reviewSourceState = useReviewSourceState({
    runId: runId ?? undefined,
    sessionId: sessionId ?? undefined,
    liveGitFiles,
    enabled: shouldLoadReviewData,
  });
  const {
    artifactDiffState,
    promptArtifactSource,
    reviewScope,
    reviewSource,
    reviewSourceLoading,
    reviewSourceError,
    openLiveGitReviewSource,
    openPromptArtifactReviewSource,
    selectReviewScope,
  } = reviewSourceState;
  const {
    diff: artifactDiff,
    loading: artifactDiffLoading,
    error: artifactDiffError,
    fetch: fetchArtifactDiff,
  } = artifactDiffState;
  const reviewFiles = useMemo(
    () =>
      reviewSource.kind === "prompt_artifact"
        ? mapArtifactFilesToStatus(promptArtifactSource?.files ?? [])
        : liveGitFiles,
    [liveGitFiles, promptArtifactSource?.files, reviewSource.kind],
  );
  const diff = reviewSource.kind === "prompt_artifact" ? artifactDiff : liveDiff;
  const activeDiffLoading =
    reviewSource.kind === "prompt_artifact"
      ? artifactDiffLoading
      : liveDiffLoading;
  const activeDiffError =
    reviewSource.kind === "prompt_artifact" ? artifactDiffError : liveDiffError;
  const diffLoading =
    reviewSource.kind === "prompt_artifact"
      ? artifactDiffLoading || reviewSourceLoading
      : liveDiffLoading;
  const diffError =
    reviewSource.kind === "prompt_artifact"
      ? artifactDiffError ?? reviewSourceError
      : liveDiffError;
  const stagedFiles = useMemo(
    () => collectStagedFilePaths(status?.files ?? []),
    [status?.files],
  );
  const fileSelection = useReviewFileSelection({
    files: reviewFiles,
    stagedFiles,
    reviewSourceKind: reviewSource.kind,
    fetchLiveDiff,
    fetchArtifactDiff,
  });
  const currentDiffFingerprint = useMemo(
    () => (diff ? buildDiffFingerprint(diff) : null),
    [diff],
  );
  const commentsState = useReviewCommentsState({
    runId,
    sessionId,
    selectedFilePath: fileSelection.activeSelectedFilePath,
    diff,
    currentDiffFingerprint,
  });
  const stageActions = useReviewStageActions({
    runId,
    sessionId,
    files: status?.files ?? [],
    stagedFiles,
    selectedFilePath: fileSelection.selectedFilePath,
    fetchLiveDiff,
    refetch,
  });
  const reviewDiffSourceKey = buildReviewDiffSourceKey({
    reviewSource,
    artifactId: promptArtifactSource?.artifactId,
  });
  useReviewDiffLoader({
    sourceKey: reviewDiffSourceKey,
    selectedPath: fileSelection.activeSelectedFilePath,
    staged: fileSelection.activeSelectedFilePath
      ? stagedFiles.has(fileSelection.activeSelectedFilePath)
      : false,
    enabled: shouldLoadReviewData,
    diff,
    diffLoading: activeDiffLoading,
    diffError: activeDiffError,
    reviewSourceKind: reviewSource.kind,
    fetchLiveDiff,
    fetchArtifactDiff,
  });
  const openLiveGitReview = useCallback((): void => {
    openLiveGitReviewSource();
    fileSelection.setSelectedFilePath(null);
    onReviewOpenChange(true);
  }, [fileSelection, onReviewOpenChange, openLiveGitReviewSource]);
  const openPromptArtifactReview = useCallback(
    (artifactId: string, assistantMessageId?: string): void => {
      openPromptArtifactReviewSource(artifactId, assistantMessageId);
      fileSelection.setSelectedFilePath(null);
      onReviewOpenChange(true);
    },
    [fileSelection, onReviewOpenChange, openPromptArtifactReviewSource],
  );
  const setReviewScope = useCallback(
    (scope: Parameters<typeof selectReviewScope>[0]): void => {
      selectReviewScope(scope);
      fileSelection.setSelectedFilePath(null);
    },
    [fileSelection, selectReviewScope],
  );
  const openReview = useCallback(
    (path?: string): void => {
      onReviewOpenChange(true);
      if (path) {
        void fileSelection.selectFilePath(path, stagedFiles.has(path));
        return;
      }

      fileSelection.selectFirstFile();
    },
    [fileSelection, onReviewOpenChange, stagedFiles],
  );
  const closeReview = useCallback((): void => {
    onReviewOpenChange(false);
  }, [onReviewOpenChange]);
  const submitCommit = useCallback(
    async (identityOverride?: {
      authorName?: string;
      authorEmail?: string;
    }): Promise<boolean> => {
      stageActions.setStageError(null);
      const message =
        commitMessage.trim() || generateCommitMessage(status?.files ?? []);
      const committed = await commit({ message, ...identityOverride });
      if (!committed) {
        return false;
      }

      setCommitMessage("");
      fileSelection.setSelectedFilePath(null);
      await refetch(true);
      return true;
    },
    [commit, commitMessage, fileSelection, refetch, stageActions, status?.files],
  );
  const forceRefetch = useCallback(async (): Promise<void> => {
    await refetch(true);
  }, [refetch]);
  const contextValue: GitReviewContextValue = {
    status,
    gitAvailable,
    statusLoading,
    isGitWorkspaceRecovering,
    statusError,
    diff,
    diffError,
    stageError: stageActions.stageError,
    commitError,
    commitErrorCode: commitErrorState?.code ?? null,
    commitErrorMetadata: commitErrorState?.metadata ?? null,
    diffLoading,
    committing,
    isReviewOpen,
    selectedFile: fileSelection.selectedFile,
    reviewFiles,
    stagedFiles,
    commitMessage,
    ...commentsState,
    currentDiffFingerprint,
    reviewScope,
    setReviewScope,
    reviewSource,
    reviewSourceLoading,
    reviewSourceError,
    openReview,
    openPromptArtifactReview,
    openLiveGitReview,
    closeReview,
    selectFile: fileSelection.selectFile,
    toggleFileStaged: stageActions.toggleFileStaged,
    stageAll: stageActions.stageAll,
    unstageAll: stageActions.unstageAll,
    createBranch: stageActions.createBranch,
    pushBranch: stageActions.pushBranch,
    submitCommit,
    setCommitMessage,
    refetch: forceRefetch,
  };

  return (
    <GitReviewContext.Provider value={contextValue}>
      {children}
    </GitReviewContext.Provider>
  );
}
