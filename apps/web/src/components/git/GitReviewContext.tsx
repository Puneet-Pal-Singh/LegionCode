/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DiffContent,
  EditArtifactReviewFile,
  FileStatus,
  GitMutationErrorMetadata,
  GitMutationErrorCode,
  GitStatusResponse,
} from "@repo/shared-types";
import { useRunContext } from "../../hooks/useRunContext";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitDiff } from "../../hooks/useGitDiff";
import { useReviewSourceState } from "../../hooks/useReviewSourceState";
import { useGitCommit } from "../../hooks/useGitCommit";
import {
  createGitBranch,
  pushGitBranch,
  stageGitFiles,
} from "../../lib/git-client.js";
import { EMPTY_FILE_STATUSES } from "../../lib/empty-collections";
import {
  buildDiffFingerprint,
  rebindReviewCommentDraft,
  type CreateReviewCommentInput,
  type ReviewCommentDraft,
} from "./reviewComments";
import {
  type ReviewSourceSelection,
  type ReviewScope,
} from "../../services/review/ReviewSourceResolver";

interface GitReviewProviderProps {
  children: React.ReactNode;
  isReviewOpen: boolean;
  onReviewOpenChange: (open: boolean) => void;
  isReviewActive?: boolean;
  isGitWorkspaceRecovering?: boolean;
}

export type { ReviewScope } from "../../services/review/ReviewSourceResolver";

interface GitReviewContextValue {
  status: GitStatusResponse | null;
  gitAvailable: boolean;
  statusLoading: boolean;
  isGitWorkspaceRecovering: boolean;
  statusError: string | null;
  diff: DiffContent | null;
  diffError: string | null;
  stageError: string | null;
  commitError: string | null;
  commitErrorCode: GitMutationErrorCode | null;
  commitErrorMetadata: GitMutationErrorMetadata | null;
  diffLoading: boolean;
  committing: boolean;
  isReviewOpen: boolean;
  selectedFile: FileStatus | null;
  reviewFiles: FileStatus[];
  stagedFiles: Set<string>;
  commitMessage: string;
  reviewComments: ReviewCommentDraft[];
  selectedReviewComments: ReviewCommentDraft[];
  selectedReviewCommentCount: number;
  selectedReviewCommentsForFile: ReviewCommentDraft[];
  currentDiffFingerprint: string | null;
  reviewScope: ReviewScope;
  setReviewScope: (scope: ReviewScope) => void;
  reviewSource: ReviewSourceSelection;
  reviewSourceLoading: boolean;
  reviewSourceError: string | null;
  openReview: (path?: string) => void;
  openPromptArtifactReview: (
    artifactId: string,
    assistantMessageId?: string,
  ) => void;
  openLiveGitReview: () => void;
  closeReview: () => void;
  selectFile: (file: FileStatus) => void;
  addReviewComment: (input: CreateReviewCommentInput) => void;
  deleteReviewComment: (commentId: string) => void;
  toggleReviewCommentSelected: (
    commentId: string,
    nextSelected: boolean,
  ) => void;
  markReviewCommentsDispatching: (commentIds: string[]) => void;
  markReviewCommentsDispatched: (commentIds: string[]) => void;
  markReviewCommentsDispatchFailed: (
    commentIds: string[],
    options?: { reselect: boolean },
  ) => void;
  toggleFileStaged: (path: string, nextStaged: boolean) => Promise<void>;
  stageAll: () => Promise<boolean>;
  unstageAll: () => Promise<boolean>;
  createBranch: (branch: string) => Promise<string>;
  pushBranch: (branch?: string) => Promise<string>;
  submitCommit: (identityOverride?: {
    authorName?: string;
    authorEmail?: string;
  }) => Promise<boolean>;
  setCommitMessage: (message: string) => void;
  refetch: () => Promise<void>;
}

const GitReviewContext = createContext<GitReviewContextValue | null>(null);
const DEFAULT_COMMIT_SCOPE = "review";

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

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [stageError, setStageError] = useState<string | null>(null);
  const [reviewComments, setReviewComments] = useState<ReviewCommentDraft[]>([]);
  const autoFetchedDiffKeyRef = useRef<string | null>(null);
  const liveGitFiles = status?.files ?? EMPTY_FILE_STATUSES;
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
  } = useReviewSourceState({
    runId: runId ?? undefined,
    sessionId: sessionId ?? undefined,
    liveGitFiles,
    enabled: shouldLoadReviewData,
  });
  const {
    diff: artifactDiff,
    loading: artifactDiffLoading,
    error: artifactDiffError,
    fetch: fetchArtifactDiff,
  } = artifactDiffState;
  const activeFiles = useMemo(
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
  const currentDiffFingerprint = useMemo(
    () => (diff ? buildDiffFingerprint(diff) : null),
    [diff],
  );

  const activeSelectedFilePath = selectedFilePath ?? activeFiles[0]?.path ?? null;
  const selectedFile = useMemo(() => {
    if (!activeSelectedFilePath) {
      return null;
    }

    return activeFiles.find((file) => file.path === activeSelectedFilePath) ?? null;
  }, [activeFiles, activeSelectedFilePath]);

  const stagedFiles = useMemo(
    () =>
      new Set(
        (status?.files ?? [])
          .filter((file) => file.isStaged)
          .map((file) => file.path),
      ),
    [status],
  );

  const effectiveReviewComments = useMemo(
    () =>
      reviewComments.map((comment) => {
        if (
          !activeSelectedFilePath ||
          !diff ||
          !currentDiffFingerprint ||
          comment.filePath !== activeSelectedFilePath ||
          comment.diffFingerprint === currentDiffFingerprint
        ) {
          return comment;
        }

        return rebindReviewCommentDraft(comment, diff, currentDiffFingerprint);
      }),
    [activeSelectedFilePath, currentDiffFingerprint, diff, reviewComments],
  );

  const selectedReviewComments = useMemo(
    () =>
      effectiveReviewComments.filter(
        (comment) => comment.selected && !comment.stale,
      ),
    [effectiveReviewComments],
  );
  const selectedReviewCommentCount = selectedReviewComments.length;
  const selectedReviewCommentsForFile = useMemo(() => {
    if (!activeSelectedFilePath) {
      return [];
    }

    return effectiveReviewComments.filter(
      (comment) => comment.filePath === activeSelectedFilePath,
    );
  }, [activeSelectedFilePath, effectiveReviewComments]);

  const selectSavedFileForReview = useCallback(
    async (path: string): Promise<void> => {
      setSelectedFilePath(path);
      await fetchArtifactDiff(path);
    },
    [fetchArtifactDiff],
  );

  const selectLiveFileForReview = useCallback(
    async (path: string, staged: boolean): Promise<void> => {
      setSelectedFilePath(path);
      await fetchLiveDiff(path, staged);
    },
    [fetchLiveDiff],
  );

  const selectFilePathForReview = useCallback(
    async (path: string, staged: boolean): Promise<void> => {
      if (reviewSource.kind === "prompt_artifact") {
        await selectSavedFileForReview(path);
        return;
      }

      await selectLiveFileForReview(path, staged);
    },
    [reviewSource.kind, selectLiveFileForReview, selectSavedFileForReview],
  );

  useEffect(() => {
    const staged = activeSelectedFilePath
      ? stagedFiles.has(activeSelectedFilePath)
      : false;
    const sourceIdentity =
      reviewSource.kind === "prompt_artifact"
        ? (promptArtifactSource?.artifactId ?? "pending-artifact")
        : "live-git";
    const autoFetchKey = activeSelectedFilePath
      ? `${sourceIdentity}:${activeSelectedFilePath}:${staged ? "staged" : "unstaged"}`
      : null;
    if (
      !shouldLoadReviewData ||
      !activeSelectedFilePath ||
      !autoFetchKey ||
      autoFetchedDiffKeyRef.current === autoFetchKey ||
      diff ||
      activeDiffLoading ||
      activeDiffError
    ) {
      return;
    }

    autoFetchedDiffKeyRef.current = autoFetchKey;
    if (reviewSource.kind === "prompt_artifact") {
      void fetchArtifactDiff(activeSelectedFilePath);
      return;
    }
    void fetchLiveDiff(activeSelectedFilePath, staged);
  }, [
    activeSelectedFilePath,
    activeDiffError,
    activeDiffLoading,
    diff,
    fetchArtifactDiff,
    fetchLiveDiff,
    shouldLoadReviewData,
    promptArtifactSource?.artifactId,
    reviewSource.kind,
    stagedFiles,
  ]);

  const openLiveGitReview = useCallback(() => {
    openLiveGitReviewSource();
    setSelectedFilePath(null);
    onReviewOpenChange(true);
  }, [onReviewOpenChange, openLiveGitReviewSource]);

  const openPromptArtifactReview = useCallback(
    (artifactId: string, assistantMessageId?: string) => {
      openPromptArtifactReviewSource(artifactId, assistantMessageId);
      setSelectedFilePath(null);
      onReviewOpenChange(true);
    },
    [onReviewOpenChange, openPromptArtifactReviewSource],
  );

  const setReviewScope = useCallback(
    (scope: ReviewScope) => {
      selectReviewScope(scope);
      setSelectedFilePath(null);
    },
    [selectReviewScope],
  );

  const openReview = useCallback(
    (path?: string) => {
      onReviewOpenChange(true);
      if (path) {
        void selectFilePathForReview(path, stagedFiles.has(path));
        return;
      }

      if (!selectedFilePath) {
        const [firstFile] = activeFiles;
        if (firstFile) {
          void selectFilePathForReview(
            firstFile.path,
            stagedFiles.has(firstFile.path),
          );
        }
      }
    },
    [
      onReviewOpenChange,
      activeFiles,
      selectFilePathForReview,
      selectedFilePath,
      stagedFiles,
    ],
  );

  const closeReview = useCallback(() => {
    onReviewOpenChange(false);
  }, [onReviewOpenChange]);

  const selectFile = useCallback(
    (file: FileStatus) => {
      void selectFilePathForReview(file.path, file.isStaged);
    },
    [selectFilePathForReview],
  );

  const addReviewComment = useCallback(
    (input: CreateReviewCommentInput) => {
      if (!runId || !sessionId) {
        return;
      }

      setReviewComments((previous) => [
        {
          id: crypto.randomUUID(),
          filePath: input.filePath,
          line: input.line,
          side: input.side,
          note: input.note,
          createdAt: new Date().toISOString(),
          linePreview: input.linePreview,
          selected: true,
          anchors: input.anchors,
          primaryAnchor: input.primaryAnchor,
          selectionMode: input.selectionMode,
          runId,
          sessionId,
          diffFingerprint: input.diffFingerprint,
          stale: false,
          deliveryState: "draft",
        },
        ...previous,
      ]);
    },
    [runId, sessionId],
  );

  const deleteReviewComment = useCallback((commentId: string) => {
    setReviewComments((previous) =>
      previous.filter((comment) => comment.id !== commentId),
    );
  }, []);

  const toggleReviewCommentSelected = useCallback(
    (commentId: string, nextSelected: boolean) => {
      setReviewComments((previous) =>
        previous.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                selected: nextSelected,
              }
            : comment,
        ),
      );
    },
    [],
  );

  const updateReviewCommentDeliveryState = useCallback(
    (
      commentIds: string[],
      deliveryState: ReviewCommentDraft["deliveryState"],
      nextSelected: boolean,
    ) => {
      if (commentIds.length === 0) {
        return;
      }

      const commentIdSet = new Set(commentIds);
      setReviewComments((previous) =>
        previous.map((comment) =>
          commentIdSet.has(comment.id)
            ? {
                ...comment,
                deliveryState,
                selected: nextSelected,
              }
            : comment,
        ),
      );
    },
    [],
  );

  const markReviewCommentsDispatching = useCallback(
    (commentIds: string[]) => {
      updateReviewCommentDeliveryState(commentIds, "dispatching", false);
    },
    [updateReviewCommentDeliveryState],
  );

  const markReviewCommentsDispatched = useCallback(
    (commentIds: string[]) => {
      updateReviewCommentDeliveryState(commentIds, "dispatched", false);
    },
    [updateReviewCommentDeliveryState],
  );

  const markReviewCommentsDispatchFailed = useCallback(
    (commentIds: string[], options?: { reselect: boolean }) => {
      updateReviewCommentDeliveryState(
        commentIds,
        "dispatch_failed",
        options?.reselect ?? false,
      );
    },
    [updateReviewCommentDeliveryState],
  );

  const toggleFileStaged = useCallback(
    async (path: string, nextStaged: boolean): Promise<void> => {
      if (!runId || !sessionId) {
        setStageError(
          !runId ? "No run context available" : "No session context available",
        );
        return;
      }

      setStageError(null);

      try {
        await stageGitFiles({
          runId,
          sessionId,
          files: [path],
          unstage: !nextStaged,
        });

        if (selectedFilePath === path) {
          await fetchLiveDiff(path, nextStaged);
        }

        await refetch(true);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        setStageError(message);
        console.error("[git-review] Failed to update staged file", error);
      }
    },
    [fetchLiveDiff, refetch, runId, selectedFilePath, sessionId],
  );

  const updateManyFilesStage = useCallback(
    async (files: string[], nextStaged: boolean): Promise<boolean> => {
      if (!files.length) {
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
          files,
          unstage: !nextStaged,
        });

        if (selectedFilePath && files.includes(selectedFilePath)) {
          await fetchLiveDiff(selectedFilePath, nextStaged);
        }

        await refetch(true);
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        setStageError(message);
        console.error("[git-review] Failed to update staged files", error);
        return false;
      }
    },
    [fetchLiveDiff, refetch, runId, selectedFilePath, sessionId],
  );

  const stageAll = useCallback(async (): Promise<boolean> => {
    const files =
      status?.files
        .filter((file) => !stagedFiles.has(file.path))
        .map((file) => file.path) ?? [];

    return await updateManyFilesStage(files, true);
  }, [stagedFiles, status, updateManyFilesStage]);

  const unstageAll = useCallback(async (): Promise<boolean> => {
    const files =
      status?.files
        .filter((file) => stagedFiles.has(file.path))
        .map((file) => file.path) ?? [];

    return await updateManyFilesStage(files, false);
  }, [stagedFiles, status, updateManyFilesStage]);

  const submitCommit = useCallback(
    async (identityOverride?: {
      authorName?: string;
      authorEmail?: string;
    }): Promise<boolean> => {
      setStageError(null);
      const message =
        commitMessage.trim() || generateCommitMessage(status?.files ?? []);
      const committed = await commit({ message, ...identityOverride });
      if (!committed) {
        return false;
      }

      setCommitMessage("");
      setSelectedFilePath(null);
      await refetch(true);
      return true;
    },
    [commit, commitMessage, refetch, status?.files],
  );

  const createBranchForRun = useCallback(
    async (branch: string): Promise<string> => {
      if (!runId || !sessionId) {
        throw new Error(
          !runId ? "No run context available" : "No session context available",
        );
      }

      const result = await createGitBranch({
        runId,
        sessionId,
        payload: { branch },
      });
      await refetch(true);
      return result.branch;
    },
    [refetch, runId, sessionId],
  );

  const pushBranchForRun = useCallback(
    async (branch?: string): Promise<string> => {
      if (!runId || !sessionId) {
        throw new Error(
          !runId ? "No run context available" : "No session context available",
        );
      }

      const result = await pushGitBranch({
        runId,
        sessionId,
        payload: {
          branch,
        },
      });
      await refetch(true);
      return result.branch;
    },
    [refetch, runId, sessionId],
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
    stageError,
    commitError,
    commitErrorCode: commitErrorState?.code ?? null,
    commitErrorMetadata: commitErrorState?.metadata ?? null,
    diffLoading,
    committing,
    isReviewOpen,
    selectedFile,
    reviewFiles: activeFiles,
    stagedFiles,
    commitMessage,
    reviewComments: effectiveReviewComments,
    selectedReviewComments,
    selectedReviewCommentCount,
    selectedReviewCommentsForFile,
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
    selectFile,
    addReviewComment,
    deleteReviewComment,
    toggleReviewCommentSelected,
    markReviewCommentsDispatching,
    markReviewCommentsDispatched,
    markReviewCommentsDispatchFailed,
    toggleFileStaged,
    stageAll,
    unstageAll,
    createBranch: createBranchForRun,
    pushBranch: pushBranchForRun,
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

export function useGitReview(): GitReviewContextValue {
  const context = useContext(GitReviewContext);

  if (!context) {
    throw new Error("useGitReview must be used within a GitReviewProvider");
  }

  return context;
}

function generateCommitMessage(files: FileStatus[]): string {
  if (files.length === 0) {
    return `chore(${DEFAULT_COMMIT_SCOPE}): update workspace`;
  }

  if (files.length === 1) {
    return `chore(${DEFAULT_COMMIT_SCOPE}): update ${files[0]?.path ?? "workspace"}`;
  }

  return `chore(${DEFAULT_COMMIT_SCOPE}): update ${files.length} files`;
}

function mapArtifactFilesToStatus(
  files: EditArtifactReviewFile[],
): FileStatus[] {
  return files.map((file) => ({
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    isStaged: file.isStaged ?? false,
  }));
}
