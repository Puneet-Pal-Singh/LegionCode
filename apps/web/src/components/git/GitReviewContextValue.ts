import { createContext } from "react";
import type {
  DiffContent,
  FileStatus,
  GitMutationErrorCode,
  GitMutationErrorMetadata,
  GitStatusResponse,
} from "@repo/shared-types";
import type {
  ReviewScope,
  ReviewSourceSelection,
} from "../../services/review/ReviewSourceResolver";
import type {
  CreateReviewCommentInput,
  ReviewCommentDraft,
} from "./reviewComments";

export interface GitReviewProviderProps {
  children: React.ReactNode;
  isReviewOpen: boolean;
  onReviewOpenChange: (open: boolean) => void;
  isReviewActive?: boolean;
  isGitWorkspaceRecovering?: boolean;
}

export interface GitReviewContextValue {
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

export const GitReviewContext = createContext<GitReviewContextValue | null>(
  null,
);
