import {
  isCodingToolId,
  type CodingToolInputByName,
  type CodingToolId,
  validateCodingToolInput,
} from "../tools/CodingToolRegistry.js";

export interface ToolPresentation {
  description: string;
  displayText: string;
  summary: string;
}

type ToolPresentationToolName = CodingToolId | "search_code";

type ToolPresentationInputByName = CodingToolInputByName & {
  search_code: CodingToolInputByName["grep"];
};

type ToolPresenter<T extends ToolPresentationToolName> = (
  input: ToolPresentationInputByName[T],
) => ToolPresentation;

type ToolPresentationDispatcher = (input: unknown) => ToolPresentation;

export function getToolPresentation(
  toolName: string,
  input: Record<string, unknown> | undefined,
): ToolPresentation {
  const explicitDescription = readString(input?.description);
  const explicitDisplayText = readString(input?.displayText);

  const derived = deriveToolPresentation(toolName, input);
  return {
    description: explicitDescription ?? derived.description,
    displayText:
      explicitDisplayText ??
      explicitDescription ??
      derived.displayText ??
      derived.description,
    summary: derived.summary,
  };
}

function deriveToolPresentation(
  toolName: string,
  input: Record<string, unknown> | undefined,
): ToolPresentation {
  if (!isToolPresentationToolName(toolName)) {
    return presentDefaultTool(toolName);
  }

  const presenter = TOOL_PRESENTERS[toolName];
  if (presenter) {
    return presenter(input);
  }

  return presentDefaultTool(toolName);
}

const TOOL_PRESENTERS: Record<
  ToolPresentationToolName,
  ToolPresentationDispatcher
> = {
  read_file: (input) =>
    presentReadFile(validateToolPresentationInput("read_file", input)),
  list_files: (input) =>
    presentListFiles(validateToolPresentationInput("list_files", input)),
  glob: (input) => presentGlob(validateToolPresentationInput("glob", input)),
  grep: (input) =>
    presentGrepOrSearchCode(validateToolPresentationInput("grep", input)),
  search_code: (input) =>
    presentGrepOrSearchCode(
      validateToolPresentationInput("search_code", input),
    ),
  write_file: (input) =>
    presentWriteFile(validateToolPresentationInput("write_file", input)),
  edit_file: (input) =>
    presentEditFile(validateToolPresentationInput("edit_file", input)),
  multi_edit: (input) =>
    presentMultiEdit(validateToolPresentationInput("multi_edit", input)),
  apply_patch: (input) =>
    presentApplyPatch(validateToolPresentationInput("apply_patch", input)),
  format_file: (input) =>
    presentFormatFile(validateToolPresentationInput("format_file", input)),
  language_diagnostics: (input) =>
    presentLanguageDiagnostics(
      validateToolPresentationInput("language_diagnostics", input),
    ),
  bash: (input) => presentBash(validateToolPresentationInput("bash", input)),
  git_stage: (input) =>
    presentGitStage(validateToolPresentationInput("git_stage", input)),
  git_commit: (input) =>
    presentGitCommit(validateToolPresentationInput("git_commit", input)),
  git_push: (input) =>
    presentGitPush(validateToolPresentationInput("git_push", input)),
  git_pull: (input) =>
    presentGitPull(validateToolPresentationInput("git_pull", input)),
  git_create_pull_request: (input) =>
    presentGitCreatePullRequest(
      validateToolPresentationInput("git_create_pull_request", input),
    ),
  git_branch_create: (input) =>
    presentGitBranchCreate(
      validateToolPresentationInput("git_branch_create", input),
    ),
  git_branch_switch: (input) =>
    presentGitBranchSwitch(
      validateToolPresentationInput("git_branch_switch", input),
    ),
  git_status: (input) =>
    presentGitStatus(validateToolPresentationInput("git_status", input)),
  git_diff: (input) =>
    presentGitDiff(validateToolPresentationInput("git_diff", input)),
  github_pr_list: (input) =>
    presentGitHubPullRequestList(
      validateToolPresentationInput("github_pr_list", input),
    ),
  github_pr_get: (input) =>
    presentGitHubPullRequestGet(
      validateToolPresentationInput("github_pr_get", input),
    ),
  github_pr_checks_get: (input) =>
    presentGitHubPullRequestChecksGet(
      validateToolPresentationInput("github_pr_checks_get", input),
    ),
  github_review_threads_get: (input) =>
    presentGitHubReviewThreadsGet(
      validateToolPresentationInput("github_review_threads_get", input),
    ),
  github_issue_get: (input) =>
    presentGitHubIssueGet(
      validateToolPresentationInput("github_issue_get", input),
    ),
  github_actions_run_get: (input) =>
    presentGitHubActionsRunGet(
      validateToolPresentationInput("github_actions_run_get", input),
    ),
  github_actions_job_logs_get: (input) =>
    presentGitHubActionsJobLogsGet(
      validateToolPresentationInput("github_actions_job_logs_get", input),
    ),
  github_cli_pr_checks_get: (input) =>
    presentGitHubCliPullRequestChecksGet(
      validateToolPresentationInput("github_cli_pr_checks_get", input),
    ),
  github_cli_actions_run_get: (input) =>
    presentGitHubCliActionsRunGet(
      validateToolPresentationInput("github_cli_actions_run_get", input),
    ),
  github_cli_actions_job_logs_get: (input) =>
    presentGitHubCliActionsJobLogsGet(
      validateToolPresentationInput("github_cli_actions_job_logs_get", input),
    ),
  github_cli_pr_comment: (input) =>
    presentGitHubCliPullRequestComment(
      validateToolPresentationInput("github_cli_pr_comment", input),
    ),
};

function presentReadFile(
  input: ToolPresentationInputByName["read_file"],
): ToolPresentation {
  const path = input.path;
  return {
    description: path ? `Read ${path}` : "Read file",
    displayText: path ? `Reading ${path}` : "Reading file",
    summary: path
      ? `Reading file contents from ${path}.`
      : "Reading file contents from the workspace.",
  };
}

function presentListFiles(
  input: ToolPresentationInputByName["list_files"],
): ToolPresentation {
  const path = input.path;
  const target = path && path !== "." ? path : "project files";
  return {
    description: path && path !== "." ? `List ${path}` : "List project files",
    displayText: `Listing ${target}`,
    summary:
      path && path !== "."
        ? `Listing files in ${path}.`
        : "Listing files in the current workspace.",
  };
}

function presentGlob(
  input: ToolPresentationInputByName["glob"],
): ToolPresentation {
  const pattern = input.pattern;
  return {
    description: pattern ? `Find ${pattern}` : "Find files",
    displayText: pattern ? `Finding ${pattern}` : "Finding files",
    summary: pattern
      ? `Finding files that match ${pattern}.`
      : "Finding matching files in the workspace.",
  };
}

function presentGrepOrSearchCode(
  input:
    | ToolPresentationInputByName["grep"]
    | ToolPresentationInputByName["search_code"],
): ToolPresentation {
  const pattern = input.pattern;
  const path = input.path;
  return {
    description: pattern ? `Search for ${pattern}` : "Search project",
    displayText: pattern ? `Searching for ${pattern}` : "Searching project",
    summary:
      pattern && path && path !== "."
        ? `Searching ${path} for ${pattern}.`
        : pattern
          ? `Searching the workspace for ${pattern}.`
          : "Searching the workspace for matching content.",
  };
}

function presentWriteFile(
  input: ToolPresentationInputByName["write_file"],
): ToolPresentation {
  const path = input.path;
  return {
    description: path ? `Edit ${path}` : "Edit file",
    displayText: path ? `Editing ${path}` : "Editing file",
    summary: path
      ? `Applying a workspace edit to ${path}.`
      : "Applying a workspace edit.",
  };
}

function presentEditFile(
  input: ToolPresentationInputByName["edit_file"],
): ToolPresentation {
  return {
    description: `Edit ${input.path}`,
    displayText: `Editing ${input.path}`,
    summary: `Replacing exact text in ${input.path}.`,
  };
}

function presentMultiEdit(
  input: ToolPresentationInputByName["multi_edit"],
): ToolPresentation {
  const fileCount = input.edits.length;
  return {
    description: `Edit ${fileCount} files`,
    displayText: `Editing ${fileCount} files`,
    summary: `Applying coordinated exact edits across ${fileCount} files.`,
  };
}

function presentApplyPatch(
  input: ToolPresentationInputByName["apply_patch"],
): ToolPresentation {
  const action = input.dryRun ? "Validate patch" : "Apply patch";
  return {
    description: action,
    displayText: `${action} to workspace`,
    summary: input.dryRun
      ? "Validating a unified patch without changing files."
      : "Applying a validated unified patch to workspace files.",
  };
}

function presentFormatFile(
  input: ToolPresentationInputByName["format_file"],
): ToolPresentation {
  return {
    description: `Format ${input.path}`,
    displayText: `Formatting ${input.path}`,
    summary: `Formatting ${input.path} with the workspace formatter.`,
  };
}

function presentLanguageDiagnostics(
  input: ToolPresentationInputByName["language_diagnostics"],
): ToolPresentation {
  return {
    description: `Check ${input.path}`,
    displayText: `Checking ${input.path}`,
    summary: `Running workspace language diagnostics for ${input.path}.`,
  };
}

function presentBash(
  input: ToolPresentationInputByName["bash"],
): ToolPresentation {
  const command = input.command;
  return {
    description: command ? `Run ${command}` : "Run command",
    displayText: command ? `Running ${command}` : "Running command",
    summary: command
      ? `Running ${command} in the workspace.`
      : "Running a shell command in the workspace.",
  };
}

function presentGitStage(
  input: ToolPresentationInputByName["git_stage"],
): ToolPresentation {
  const files = input.files?.join(", ");
  return {
    description: files ? `Stage ${files}` : "Stage workspace changes",
    displayText: files ? `Staging ${files}` : "Staging workspace changes",
    summary: files
      ? `Staging ${files} for commit.`
      : "Staging workspace changes for commit.",
  };
}

function presentGitCommit(
  input: ToolPresentationInputByName["git_commit"],
): ToolPresentation {
  return {
    description: `Commit changes as ${input.message}`,
    displayText: "Creating git commit",
    summary: `Creating a git commit with subject "${input.message}".`,
  };
}

function presentGitPush(
  input: ToolPresentationInputByName["git_push"],
): ToolPresentation {
  const branch = input.branch;
  return {
    description: branch ? `Push ${branch}` : "Push current branch",
    displayText: branch ? `Pushing ${branch}` : "Pushing current branch",
    summary: branch
      ? `Pushing branch ${branch} to the remote.`
      : "Pushing the current branch to the remote.",
  };
}

function presentGitPull(
  input: ToolPresentationInputByName["git_pull"],
): ToolPresentation {
  const branch = input.branch;
  return {
    description: branch ? `Pull ${branch}` : "Pull current branch",
    displayText: branch ? `Pulling ${branch}` : "Pulling current branch",
    summary: branch
      ? `Syncing branch ${branch} from the remote with a fast-forward-only pull.`
      : "Syncing the current branch from the remote with a fast-forward-only pull.",
  };
}

function presentGitCreatePullRequest(
  input: ToolPresentationInputByName["git_create_pull_request"],
): ToolPresentation {
  return {
    description: `Create pull request ${input.title}`,
    displayText: "Creating pull request",
    summary: `Creating a pull request for ${input.owner}/${input.repo} with title "${input.title}".`,
  };
}

function presentGitBranchCreate(
  input: ToolPresentationInputByName["git_branch_create"],
): ToolPresentation {
  return {
    description: `Create branch ${input.branch}`,
    displayText: `Creating branch ${input.branch}`,
    summary: `Creating and switching to branch ${input.branch}.`,
  };
}

function presentGitBranchSwitch(
  input: ToolPresentationInputByName["git_branch_switch"],
): ToolPresentation {
  return {
    description: `Switch to ${input.branch}`,
    displayText: `Switching to ${input.branch}`,
    summary: `Switching to branch ${input.branch}.`,
  };
}

function presentGitStatus(
  _input: ToolPresentationInputByName["git_status"],
): ToolPresentation {
  return {
    description: "Check git status",
    displayText: "Checking git status",
    summary: "Checking the current repository status.",
  };
}

function presentGitDiff(
  input: ToolPresentationInputByName["git_diff"],
): ToolPresentation {
  const path = input.path;
  return {
    description: path ? `Check git diff for ${path}` : "Check git diff",
    displayText: path ? `Checking git diff for ${path}` : "Checking git diff",
    summary: path
      ? `Checking repository changes for ${path}.`
      : "Checking repository changes in the workspace.",
  };
}

function presentGitHubPullRequestList(
  input: ToolPresentationInputByName["github_pr_list"],
): ToolPresentation {
  const branchSuffix = input.head ? ` for ${input.head}` : "";
  const state = input.state ?? "open";
  return {
    description: `List ${state} PRs${branchSuffix}`,
    displayText: `Loading ${state} PRs${branchSuffix}`,
    summary: `Loading ${state} pull requests${branchSuffix} from ${input.owner}/${input.repo}.`,
  };
}

function presentGitHubPullRequestGet(
  input: ToolPresentationInputByName["github_pr_get"],
): ToolPresentation {
  return {
    description: `Load PR #${input.number}`,
    displayText: `Loading PR #${input.number}`,
    summary: `Loading pull request #${input.number} from ${input.owner}/${input.repo}.`,
  };
}

function presentGitHubPullRequestChecksGet(
  input: ToolPresentationInputByName["github_pr_checks_get"],
): ToolPresentation {
  return {
    description: `Load PR #${input.number} checks`,
    displayText: `Loading checks for PR #${input.number}`,
    summary: `Loading check runs for pull request #${input.number} from ${input.owner}/${input.repo}.`,
  };
}

function presentGitHubReviewThreadsGet(
  input: ToolPresentationInputByName["github_review_threads_get"],
): ToolPresentation {
  return {
    description: `Load PR #${input.number} review threads`,
    displayText: `Loading review threads for PR #${input.number}`,
    summary: `Loading review thread metadata for pull request #${input.number} from ${input.owner}/${input.repo}.`,
  };
}

function presentGitHubIssueGet(
  input: ToolPresentationInputByName["github_issue_get"],
): ToolPresentation {
  return {
    description: `Load issue #${input.number}`,
    displayText: `Loading issue #${input.number}`,
    summary: `Loading issue #${input.number} from ${input.owner}/${input.repo}.`,
  };
}

function presentGitHubActionsRunGet(
  input: ToolPresentationInputByName["github_actions_run_get"],
): ToolPresentation {
  return {
    description: `Load Actions run #${input.actionsRunId}`,
    displayText: `Loading Actions run #${input.actionsRunId}`,
    summary: `Loading GitHub Actions run #${input.actionsRunId} from ${input.owner}/${input.repo}.`,
  };
}

function presentGitHubActionsJobLogsGet(
  input: ToolPresentationInputByName["github_actions_job_logs_get"],
): ToolPresentation {
  return {
    description: `Load Actions job #${input.actionsJobId} logs`,
    displayText: `Loading logs for job #${input.actionsJobId}`,
    summary: `Loading GitHub Actions job logs for #${input.actionsJobId} from ${input.owner}/${input.repo}.`,
  };
}

function presentGitHubCliPullRequestChecksGet(
  input: ToolPresentationInputByName["github_cli_pr_checks_get"],
): ToolPresentation {
  return {
    description: `Load PR #${input.number} checks (CLI lane)`,
    displayText: `Loading checks for PR #${input.number} via CLI`,
    summary: `Loading check runs for pull request #${input.number} from ${input.owner}/${input.repo} through the bounded GitHub CLI lane.`,
  };
}

function presentGitHubCliActionsRunGet(
  input: ToolPresentationInputByName["github_cli_actions_run_get"],
): ToolPresentation {
  return {
    description: `Load Actions run #${input.actionsRunId} (CLI lane)`,
    displayText: `Loading Actions run #${input.actionsRunId} via CLI`,
    summary: `Loading GitHub Actions run #${input.actionsRunId} from ${input.owner}/${input.repo} through the bounded GitHub CLI lane.`,
  };
}

function presentGitHubCliActionsJobLogsGet(
  input: ToolPresentationInputByName["github_cli_actions_job_logs_get"],
): ToolPresentation {
  return {
    description: `Load Actions job #${input.actionsJobId} logs (CLI lane)`,
    displayText: `Loading logs for job #${input.actionsJobId} via CLI`,
    summary: `Loading GitHub Actions job logs for #${input.actionsJobId} from ${input.owner}/${input.repo} through the bounded GitHub CLI lane.`,
  };
}

function presentGitHubCliPullRequestComment(
  input: ToolPresentationInputByName["github_cli_pr_comment"],
): ToolPresentation {
  return {
    description: `Comment on PR #${input.number} (CLI lane)`,
    displayText: `Posting PR #${input.number} comment via CLI`,
    summary: `Posting a bounded GitHub CLI comment to pull request #${input.number} in ${input.owner}/${input.repo}.`,
  };
}

function presentDefaultTool(toolName: string): ToolPresentation {
  const label = humanizeToolName(toolName);
  return {
    description: label,
    displayText: label,
    summary: `${label} in progress.`,
  };
}

function humanizeToolName(toolName: string): string {
  return toolName
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isToolPresentationToolName(
  toolName: string,
): toolName is ToolPresentationToolName {
  return toolName === "search_code" || isCodingToolId(toolName);
}

function validateToolPresentationInput<T extends ToolPresentationToolName>(
  toolName: T,
  input: unknown,
): ToolPresentationInputByName[T] {
  try {
    if (toolName === "search_code") {
      return validateCodingToolInput(
        "grep",
        input,
      ) as ToolPresentationInputByName[T];
    }

    return validateCodingToolInput(
      toolName,
      input,
    ) as ToolPresentationInputByName[T];
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown validation error";
    throw new Error(`[tool-presentation/${toolName}] ${message}`);
  }
}
