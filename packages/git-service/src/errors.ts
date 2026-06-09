export type GitServiceErrorCode =
  | "git_command_failed"
  | "invalid_branch_ref"
  | "invalid_git_input"
  | "malformed_status_output"
  | "unsupported_status_record";

export type GitServiceErrorContextValue =
  | string
  | number
  | boolean
  | null
  | readonly string[];

export type GitServiceErrorContext = Readonly<
  Record<string, GitServiceErrorContextValue>
>;

export class GitServiceError extends Error {
  readonly code: GitServiceErrorCode;
  readonly context: GitServiceErrorContext;

  constructor(
    code: GitServiceErrorCode,
    message: string,
    context: GitServiceErrorContext = {},
  ) {
    super(message);
    this.name = "GitServiceError";
    this.code = code;
    this.context = context;
  }
}

export function createGitCommandFailedError(
  args: readonly string[],
  exitCode: number,
  stderr: string,
): GitServiceError {
  return new GitServiceError("git_command_failed", "Git command failed", {
    args,
    exitCode,
    stderr,
  });
}

export function createInvalidBranchRefError(
  branchName: string,
  reason: string,
): GitServiceError {
  return new GitServiceError("invalid_branch_ref", "Invalid Git branch ref", {
    branchName,
    reason,
  });
}

export function createMalformedStatusOutputError(
  record: string,
  reason: string,
): GitServiceError {
  return new GitServiceError(
    "malformed_status_output",
    "Malformed porcelain-v2 status output",
    { reason, record },
  );
}
