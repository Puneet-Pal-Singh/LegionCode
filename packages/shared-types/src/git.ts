/**
 * Git Types - Shared types for git operations across Shadowbox apps
 * Used by Web, Brain, and Muscle layers
 */

export type FileStatusType =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked";

export interface FileStatus {
  path: string;
  status: FileStatusType;
  additions: number;
  deletions: number;
  isStaged: boolean;
}

export interface DiffLine {
  type: "unchanged" | "added" | "deleted";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  header: string;
}

export interface DiffContent {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  isNewFile: boolean;
  isDeleted: boolean;
}

export type GitCommitIdentitySource =
  | "workspace_git_config"
  | "github_profile"
  | "user_input";

export interface GitCommitIdentity {
  authorName: string;
  authorEmail: string;
  source: GitCommitIdentitySource;
  verified: boolean;
}

export type GitCommitIdentityInputReason =
  | "missing_identity"
  | "missing_name"
  | "missing_email";

export interface GitCommitIdentityReadyState {
  state: "ready";
  identity: GitCommitIdentity;
}

export interface GitCommitIdentityRequiresInputState {
  state: "requires_input";
  reason: GitCommitIdentityInputReason;
  suggestedAuthorName: string;
  suggestedAuthorEmail: string;
}

export type GitCommitIdentityState =
  | GitCommitIdentityReadyState
  | GitCommitIdentityRequiresInputState;

export type GitMutationErrorCode =
  | "COMMIT_IDENTITY_REQUIRED"
  | "COMMIT_IDENTITY_INCOMPLETE"
  | "COMMIT_IDENTITY_WRITE_FAILED"
  | "BRANCH_CREATION_FAILED"
  | "PUSH_FAILED"
  | "PR_CREATION_FAILED";

export interface GitMutationErrorMetadata {
  commitIdentity?: GitCommitIdentityState;
}

export interface GitMutationErrorResponse {
  error: string;
  code: GitMutationErrorCode;
  metadata?: GitMutationErrorMetadata;
}

export interface CommitPayload {
  message: string;
  files: string[];
  authorName?: string;
  authorEmail?: string;
}

export interface CreateBranchPayload {
  branch: string;
}

export interface GitBranchMutationResult {
  success: true;
  branch: string;
}

export interface PushPayload {
  branch: string;
  remote?: string;
}

export interface GitPushMutationResult {
  success: true;
  branch: string;
  remote: string;
}

export interface CreatePullRequestPayload {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
}

export interface CreatePullRequestFromRunPayload {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  base?: string;
}

export interface GitPullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  head: string;
  base: string;
}

export interface GitPullRequestMutationResult {
  success: true;
  pullRequest: GitPullRequestSummary;
}

export interface GitStatusReady {
  files: FileStatus[];
  ahead: number;
  behind: number;
  branch: string;
  repoIdentity?: string | null;
  commitIdentity?: GitCommitIdentity | null;
  hasStaged: boolean;
  hasUnstaged: boolean;
  gitAvailable: true;
  recoverableCode?: undefined;
}

export interface GitStatusNotRepository {
  files: [];
  ahead: 0;
  behind: 0;
  branch: "";
  repoIdentity?: string | null;
  commitIdentity?: null;
  hasStaged: false;
  hasUnstaged: false;
  gitAvailable: false;
  recoverableCode: "NOT_A_GIT_REPOSITORY";
}

export type GitStatusResponse = GitStatusReady | GitStatusNotRepository;

export interface GitDiffRequest {
  path?: string;
  staged?: boolean;
}

export interface StageFilesRequest {
  files: string[];
  unstage?: boolean;
}
