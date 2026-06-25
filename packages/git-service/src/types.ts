export interface GitWorkspaceContext {
  readonly runId: string;
  readonly filesystemRoot: string;
  readonly workingBranch: string;
}

export interface GitFilesystemContext {
  readonly runId: string;
  readonly filesystemRoot: string;
}

export interface GitStatusInput {
  readonly runId: string;
  readonly workspaceRoot: string;
}

export interface GitDiffInput {
  readonly workspace: GitFilesystemContext;
  readonly paths: readonly string[];
  readonly staged: boolean;
}

export interface GitDiffFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: GitChangedFileStatus;
  readonly additions: number;
  readonly deletions: number;
}

export interface GitDiffResult {
  readonly files: readonly GitDiffFile[];
  readonly patch: string;
}

export interface GitFileLineCount {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface GitFileLineCountsInput {
  readonly workspace: GitFilesystemContext;
  readonly paths: readonly string[];
}

export interface GitUntrackedFileInput {
  readonly workspace: GitFilesystemContext;
  readonly path: string;
}

export interface GitUntrackedFileDiffResult {
  readonly path: string;
  readonly patch: string;
}

export interface GitRepoIdentityInput {
  readonly workspace: GitFilesystemContext;
}

export interface GitConfigValueInput {
  readonly workspace: GitFilesystemContext;
  readonly key: "user.name" | "user.email" | "remote.origin.url";
}

export interface GitCapturePatchInput {
  readonly workspace: GitFilesystemContext;
  readonly internalPathPrefix?: string;
  readonly baselineTree?: string;
  readonly paths?: readonly string[];
}

export interface GitPatchCaptureResult {
  readonly patch: string;
  readonly baseCommitSha: string | null;
  readonly branch: string | null;
}

export interface GitSnapshotInput {
  readonly workspace: GitFilesystemContext;
  readonly snapshotKey: string;
}

export interface GitWorkspaceSnapshot {
  readonly runId: string;
  readonly filesystemRoot: string;
  readonly headSha: string;
  readonly treeId: string;
}

export interface GitSnapshotDiffInput {
  readonly workspace: GitFilesystemContext;
  readonly start: GitWorkspaceSnapshot;
  readonly terminal: GitWorkspaceSnapshot;
}

export interface GitStageInput {
  readonly workspace: GitFilesystemContext;
  readonly paths: readonly string[];
}

export interface GitCommitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface GitCommitInput {
  readonly workspace: GitFilesystemContext;
  readonly paths: readonly string[];
  readonly message: string;
  readonly author: GitCommitIdentity;
}

export interface GitCommitResult {
  readonly commitSha: string;
  readonly branchName: string;
  readonly committedPaths: readonly string[];
}

export interface GitPushInput {
  readonly workspace: GitWorkspaceContext;
  readonly remoteName: string;
  readonly authArgs?: readonly string[];
}

export interface GitPushResult {
  readonly remoteName: string;
  readonly branchName: string;
  readonly headSha: string;
}

export interface GitPullInput {
  readonly workspace: GitFilesystemContext;
  readonly remoteName: string;
  readonly branchName?: string;
  readonly authArgs?: readonly string[];
}

export interface GitFetchInput {
  readonly workspace: GitFilesystemContext;
  readonly remoteName: string;
  readonly authArgs?: readonly string[];
}

export interface GitBranchInput {
  readonly workspace: GitFilesystemContext;
  readonly branchName: string;
}

export interface GitBranchResult {
  readonly branchName: string;
  readonly message: string;
}

export interface GitBranchListInput {
  readonly workspace: GitFilesystemContext;
}

export interface GitBranchListResult {
  readonly output: string;
}

export interface GitBranchValidationInput {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly branchName: string;
}

export interface GitBranchValidationResult {
  readonly branchName: string;
  readonly checkedRef: string;
}

export type GitChangedFileStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type_changed"
  | "unmerged"
  | "untracked";

export interface GitService {
  getStatus(input: GitStatusInput): Promise<GitStatusResult>;
  getDiff(input: GitDiffInput): Promise<GitDiffResult>;
  getFileLineCounts(
    input: GitFileLineCountsInput,
  ): Promise<readonly GitFileLineCount[]>;
  getUntrackedFileDiff(
    input: GitUntrackedFileInput,
  ): Promise<GitUntrackedFileDiffResult | null>;
  getRepoIdentity(input: GitRepoIdentityInput): Promise<string | null>;
  readConfigValue(input: GitConfigValueInput): Promise<string | null>;
  capturePatch(input: GitCapturePatchInput): Promise<GitPatchCaptureResult>;
  captureSnapshot(input: GitSnapshotInput): Promise<GitWorkspaceSnapshot>;
  getSnapshotDiff(input: GitSnapshotDiffInput): Promise<GitDiffResult>;
  stageFiles(input: GitStageInput): Promise<GitStatusResult>;
  unstageFiles(input: GitStageInput): Promise<GitStatusResult>;
  commit(input: GitCommitInput): Promise<GitCommitResult>;
  push(input: GitPushInput): Promise<GitPushResult>;
  pull(input: GitPullInput): Promise<void>;
  fetch(input: GitFetchInput): Promise<void>;
  createBranch(input: GitBranchInput): Promise<GitBranchResult>;
  switchBranch(input: GitBranchInput): Promise<GitBranchResult>;
  listBranches(input: GitBranchListInput): Promise<GitBranchListResult>;
  validateBranch(
    input: GitBranchValidationInput,
  ): Promise<GitBranchValidationResult>;
}

export type GitStatusCode = "." | "M" | "T" | "A" | "D" | "R" | "C" | "U";

export interface GitStatusXY {
  readonly index: GitStatusCode;
  readonly worktree: GitStatusCode;
}

export interface GitBranchStatus {
  readonly oid: string | null;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly detached: boolean;
}

export interface BaseGitStatusEntry {
  readonly path: string;
  readonly xy: GitStatusXY;
}

export interface OrdinaryGitStatusEntry extends BaseGitStatusEntry {
  readonly kind: "ordinary";
  readonly status: GitChangedFileStatus;
  readonly submodule: string;
  readonly headMode: string;
  readonly indexMode: string;
  readonly worktreeMode: string;
  readonly headObjectId: string;
  readonly indexObjectId: string;
}

export interface RenamedOrCopiedGitStatusEntry extends BaseGitStatusEntry {
  readonly kind: "renamed_or_copied";
  readonly status: "renamed" | "copied";
  readonly previousPath: string;
  readonly score: number;
  readonly submodule: string;
  readonly headMode: string;
  readonly indexMode: string;
  readonly worktreeMode: string;
  readonly headObjectId: string;
  readonly indexObjectId: string;
}

export interface UnmergedGitStatusEntry extends BaseGitStatusEntry {
  readonly kind: "unmerged";
  readonly status: "unmerged";
  readonly submodule: string;
  readonly stageOneMode: string;
  readonly stageTwoMode: string;
  readonly stageThreeMode: string;
  readonly worktreeMode: string;
  readonly stageOneObjectId: string;
  readonly stageTwoObjectId: string;
  readonly stageThreeObjectId: string;
}

export interface UntrackedGitStatusEntry {
  readonly kind: "untracked";
  readonly status: "untracked";
  readonly path: string;
}

export type GitStatusEntry =
  | OrdinaryGitStatusEntry
  | RenamedOrCopiedGitStatusEntry
  | UnmergedGitStatusEntry
  | UntrackedGitStatusEntry;

export interface GitStatusResult {
  readonly branch: GitBranchStatus;
  readonly entries: readonly GitStatusEntry[];
  readonly changedFileCount: number;
  readonly isDirty: boolean;
}
