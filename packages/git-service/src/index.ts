export { DefaultGitService } from "./GitService.js";
export {
  createGitCommandFailedError,
  createInvalidBranchRefError,
  createMalformedStatusOutputError,
  GitServiceError,
  type GitServiceErrorCode,
  type GitServiceErrorContext,
  type GitServiceErrorContextValue,
} from "./errors.js";
export {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  type GitCommandExecutionInput,
  type GitCommandExecutionResult,
  type GitCommandExecutor,
} from "./executor.js";
export {
  validateBranchNamePolicy,
  validateBranchWithGit,
  validateRemoteName,
} from "./refs.js";
export {
  GIT_STATUS_PORCELAIN_V2_ARGS,
  parsePorcelainV2Status,
} from "./status.js";
export {
  captureGitWorkspaceSnapshot,
  diffGitWorkspaceSnapshots,
} from "./snapshot.js";
export { validateWorkspaceRoot } from "./validation.js";
export type {
  BaseGitStatusEntry,
  GitBranchStatus,
  GitBranchValidationInput,
  GitBranchValidationResult,
  GitChangedFileStatus,
  GitCommitIdentity,
  GitCommitInput,
  GitCommitResult,
  GitDiffFile,
  GitDiffInput,
  GitDiffResult,
  GitFilesystemContext,
  GitPushInput,
  GitPushResult,
  GitSnapshotDiffInput,
  GitSnapshotInput,
  GitService,
  GitStageInput,
  GitStatusCode,
  GitStatusEntry,
  GitStatusInput,
  GitStatusResult,
  GitStatusXY,
  GitWorkspaceContext,
  GitWorkspaceSnapshot,
  OrdinaryGitStatusEntry,
  RenamedOrCopiedGitStatusEntry,
  UnmergedGitStatusEntry,
  UntrackedGitStatusEntry,
} from "./types.js";
