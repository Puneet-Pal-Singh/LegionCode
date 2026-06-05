import {
  getGoldenFlowToolRoute,
  isConcreteCommandInput,
  isConcretePathInput,
  validateGoldenFlowToolInput,
  type GoldenFlowToolName,
} from "../contracts/index.js";
import {
  extractExecutionFailure,
  formatExecutionResult,
} from "../agents/ResultFormatter.js";
import type { GitCommitIdentitySource } from "@repo/shared-types";
import { validateSafePath } from "../agents/validation.js";
import {
  normalizeWorkspaceShellCommand,
  resolveWorkspaceRelativeShellPath,
} from "../lib/WorkspaceShellCommand.js";
import type {
  ExecutionOutputChunk,
  RuntimeExecutionService,
  TaskInput,
  TaskResult,
} from "../types.js";

const GIT_COMMIT_IDENTITY_CONFIG_SEGMENT_PATTERN =
  /\bgit(?:\s+-C\s+\S+)?\s+config\b.*\buser\.(?:name|email)\b/i;
const INTERNAL_RUNTIME_FEATURE_FLAGS_KEY = "__runtimeFeatureFlags";

export async function executeAgenticLoopTool(
  executionService: RuntimeExecutionService,
  input: {
    taskId: string;
    toolName: GoldenFlowToolName;
    toolInput: TaskInput;
    onOutputAppended?: (chunk: {
      stdoutDelta?: string;
      stderrDelta?: string;
      truncated?: boolean;
    }) => Promise<void> | void;
  },
): Promise<TaskResult> {
  switch (input.toolName) {
    case "read_file":
      return executeReadFileTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "list_files":
      return executeListFilesTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "write_file":
      return executeWriteFileTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "bash":
      return executeBashTool(
        executionService,
        input.taskId,
        input.toolInput,
        input.onOutputAppended,
      );
    case "git_stage":
      return executeGitStageTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "git_commit":
      return executeGitCommitTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "git_push":
      return executeGitPushTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "git_pull":
      return executeGitPullTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "git_create_pull_request":
      return executeGitCreatePullRequestTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "git_branch_create":
      return executeGitBranchCreateTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "git_branch_switch":
      return executeGitBranchSwitchTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "git_status":
      return executeGitStatusTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "git_diff":
      return executeGitDiffTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_pr_list":
      return executeGitHubPullRequestListTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_pr_get":
      return executeGitHubPullRequestGetTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_pr_checks_get":
      return executeGitHubPullRequestChecksGetTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_review_threads_get":
      return executeGitHubReviewThreadsGetTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_issue_get":
      return executeGitHubIssueGetTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_actions_run_get":
      return executeGitHubActionsRunGetTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_actions_job_logs_get":
      return executeGitHubActionsJobLogsGetTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_cli_pr_checks_get":
      return executeGitHubCliPullRequestChecksGetTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_cli_actions_run_get":
      return executeGitHubCliActionsRunGetTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_cli_actions_job_logs_get":
      return executeGitHubCliActionsJobLogsGetTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "github_cli_pr_comment":
      return executeGitHubCliPullRequestCommentTool(
        executionService,
        input.taskId,
        input.toolInput,
      );
    case "glob":
      return executeGlobTool(executionService, input.taskId, input.toolInput);
    case "grep":
      return executeGrepTool(executionService, input.taskId, input.toolInput);
    default:
      return buildFailureResult(input.taskId, "Unsupported tool");
  }
}

async function executeReadFileTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput("read_file", taskInput);
  const path = normalizeToolPath(validatedInput.path);
  validateToolPath(path);
  validateSafePath(path);
  const payload: Record<string, unknown> = { path };
  if (validatedInput.offset !== undefined) {
    payload.offset = validatedInput.offset;
  }
  if (validatedInput.limit !== undefined) {
    payload.limit = validatedInput.limit;
  }

  const result = await executeGatewayPlugin(
    executionService,
    "read_file",
    payload,
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result));
}

async function executeListFilesTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput("list_files", taskInput);
  const path = validatedInput.path
    ? normalizeToolPath(validatedInput.path)
    : ".";
  if (path !== ".") {
    validateSafePath(path);
  }

  const result = await executeGatewayPlugin(executionService, "list_files", {
    path,
  });
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result));
}

async function executeWriteFileTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput("write_file", taskInput);
  const path = normalizeToolPath(validatedInput.path);
  validateToolPath(path);
  validateSafePath(path);

  const previousContent = await readExistingFileContent(executionService, path);
  const result = await executeGatewayPlugin(executionService, "write_file", {
    path,
    content: validatedInput.content,
  });
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }

  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: buildWriteActivityMetadata(
      path,
      previousContent,
      validatedInput.content,
    ),
  });
}

async function executeBashTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
  onOutputAppended?:
    | ((chunk: {
        stdoutDelta?: string;
        stderrDelta?: string;
        truncated?: boolean;
      }) => Promise<void> | void)
    | undefined,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput("bash", taskInput);
  const normalizedInput = normalizeWorkspaceShellCommand({
    command: validatedInput.command,
    cwd: validatedInput.cwd
      ? normalizeWorkspacePath(validatedInput.cwd)
      : undefined,
  });
  const command = normalizedInput.command.trim();

  if (!isConcreteCommandInput(command)) {
    return buildFailureResult(
      taskId,
      "Shell command must be a concrete non-empty command",
    );
  }

  if (isGitCommitIdentityConfigShellCommand(command)) {
    return buildFailureResult(
      taskId,
      "Do not run git config user.name/user.email through bash in agent flow. Use git_commit with authorName and authorEmail, or retry commit from the Git commit dialog so OAuth-backed identity is used.",
    );
  }

  if (isGitShellCommand(command)) {
    return buildFailureResult(
      taskId,
      "Do not run git commands through bash in agent flow. Use dedicated git_* tools (git_status, git_diff, git_stage, git_commit, git_push, git_branch_switch, git_branch_create, git_pull, git_fetch) so approval, recovery, and branch-safety handling remain deterministic.",
    );
  }

  if (/^ls(\s|$)/i.test(command)) {
    const path = resolveWorkspaceRelativeShellPath(
      normalizedInput.cwd,
      extractDirectoryFromLsCommand(command),
    );
    validateSafePath(path);
    return executeListFilesTool(executionService, taskId, {
      description: "List files from shell shortcut",
      path,
    });
  }

  const catPath = extractPathFromCatCommand(command);
  if (catPath) {
    const path = resolveWorkspaceRelativeShellPath(
      normalizedInput.cwd,
      catPath,
    );
    validateSafePath(path);
    return executeReadFileTool(executionService, taskId, {
      description: "Read file from shell shortcut",
      path,
    });
  }

  const cwd = normalizedInput.cwd
    ? normalizeWorkspacePath(normalizedInput.cwd)
    : ".";
  if (cwd !== ".") {
    validateSafePath(cwd);
  }

  const shellState = createShellState({
    command,
    cwd,
    description: validatedInput.description,
  });
  const result = await executeGatewayPlugin(
    executionService,
    "bash",
    {
      command,
      cwd: cwd === "." ? undefined : cwd,
      description: validatedInput.description,
    },
    {
      onOutput: async (chunk) => {
        appendShellState(shellState, chunk);
        await onOutputAppended?.({
          stdoutDelta: chunk.source !== "stderr" ? chunk.message : undefined,
          stderrDelta: chunk.source === "stderr" ? chunk.message : undefined,
          truncated: shellState.truncated,
        });
      },
    },
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure, {
      activity: buildShellActivityMetadata(shellState, 1),
    });
  }
  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: buildShellActivityMetadata(shellState, 0),
  });
}

async function executeGitStatusTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  validateGoldenFlowToolInput("git_status", taskInput);
  const result = await executeGatewayPlugin(executionService, "git_status", {});
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result));
}

async function executeGitStageTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const changeEvidence = await readGitChangeEvidence(executionService);
  if (changeEvidence === "no_changes") {
    return buildFailureResult(
      taskId,
      "I couldn't stage changes because there are no modified files in this workspace yet.",
    );
  }

  const validatedInput = validateGoldenFlowToolInput("git_stage", taskInput);
  const payload: Record<string, unknown> = {};
  if (validatedInput.files && validatedInput.files.length > 0) {
    payload.files = validatedInput.files.map((file) => {
      const path = normalizeWorkspacePath(file);
      validateSafePath(path);
      return path;
    });
  }

  const result = await executeGatewayPlugin(
    executionService,
    "git_stage",
    payload,
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: buildGitActivityMetadata("Staging files", {
      preview:
        validatedInput.files
          ?.map((file) => normalizeWorkspacePath(file))
          .join(", ") ?? "workspace changes",
    }),
  });
}

async function executeGitCommitTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput("git_commit", taskInput);
  const changeEvidence = await readGitChangeEvidence(executionService);
  if (changeEvidence === "no_changes") {
    return buildFailureResult(
      taskId,
      "I couldn't create a commit because there are no staged or modified files yet.",
    );
  }

  const payload: Record<string, unknown> = {
    message: validatedInput.message.trim(),
  };

  if (validatedInput.files && validatedInput.files.length > 0) {
    payload.files = validatedInput.files.map((file) => {
      const path = normalizeWorkspacePath(file);
      validateSafePath(path);
      return path;
    });
  }
  if (validatedInput.authorName) {
    payload.authorName = validatedInput.authorName.trim();
  }
  if (validatedInput.authorEmail) {
    payload.authorEmail = validatedInput.authorEmail.trim();
  }

  const result = await executeGatewayPlugin(
    executionService,
    "git_commit",
    payload,
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  const commitIdentityEvidence = readCommitIdentityEvidence(result);
  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: buildGitActivityMetadata("Creating git commit", {
      preview: validatedInput.message.trim(),
      commitIdentitySource: commitIdentityEvidence.source,
      commitIdentityVerified: commitIdentityEvidence.verified,
    }),
  });
}

async function readGitChangeEvidence(
  executionService: RuntimeExecutionService,
): Promise<"changes_present" | "no_changes" | "unknown"> {
  const gitStatusResult = await executeGatewayPlugin(
    executionService,
    "git_status",
    {},
  );
  const failure = extractExecutionFailure(gitStatusResult);
  if (failure) {
    return "unknown";
  }

  const parsed = parseGitStatusPayload(formatExecutionResult(gitStatusResult));
  if (!parsed) {
    return "unknown";
  }

  const hasChanges =
    parsed.hasStaged || parsed.hasUnstaged || parsed.files.length > 0;
  return hasChanges ? "changes_present" : "no_changes";
}

function parseGitStatusPayload(
  formattedResult: string,
): { files: unknown[]; hasStaged: boolean; hasUnstaged: boolean } | null {
  try {
    const parsed = JSON.parse(formattedResult) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const files = Array.isArray((parsed as { files?: unknown }).files)
      ? ((parsed as { files: unknown[] }).files ?? [])
      : [];
    const hasStaged =
      typeof (parsed as { hasStaged?: unknown }).hasStaged === "boolean"
        ? ((parsed as { hasStaged: boolean }).hasStaged ?? false)
        : false;
    const hasUnstaged =
      typeof (parsed as { hasUnstaged?: unknown }).hasUnstaged === "boolean"
        ? ((parsed as { hasUnstaged: boolean }).hasUnstaged ?? false)
        : false;

    return {
      files,
      hasStaged,
      hasUnstaged,
    };
  } catch {
    return null;
  }
}

async function executeGitPushTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput("git_push", taskInput);
  const payload: Record<string, unknown> = {};
  if (validatedInput.remote) {
    payload.remote = validatedInput.remote.trim();
  }
  if (validatedInput.branch) {
    payload.branch = validatedInput.branch.trim();
  }

  const result = await executeGatewayPlugin(
    executionService,
    "git_push",
    payload,
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure, {
      activity: buildGitActivityMetadata("Pushing branch", {
        branch: validatedInput.branch?.trim(),
        preview: validatedInput.branch?.trim(),
      }),
    });
  }
  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: buildGitActivityMetadata("Pushing branch", {
      branch: validatedInput.branch?.trim(),
      preview: validatedInput.branch?.trim(),
    }),
  });
}

async function executeGitPullTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput("git_pull", taskInput);
  const payload: Record<string, unknown> = {};
  if (validatedInput.remote) {
    payload.remote = validatedInput.remote.trim();
  }
  if (validatedInput.branch) {
    payload.branch = validatedInput.branch.trim();
  }

  const result = await executeGatewayPlugin(
    executionService,
    "git_pull",
    payload,
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure, {
      activity: buildGitActivityMetadata("Syncing branch", {
        branch: validatedInput.branch?.trim(),
        preview: validatedInput.branch?.trim(),
      }),
    });
  }
  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: buildGitActivityMetadata("Syncing branch", {
      branch: validatedInput.branch?.trim(),
      preview: validatedInput.branch?.trim(),
    }),
  });
}

async function executeGitCreatePullRequestTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput(
    "git_create_pull_request",
    taskInput,
  );
  const payload: Record<string, unknown> = {
    owner: validatedInput.owner.trim(),
    repo: validatedInput.repo.trim(),
    title: validatedInput.title.trim(),
  };
  if (validatedInput.body) {
    payload.body = validatedInput.body.trim();
  }
  if (validatedInput.base) {
    payload.base = validatedInput.base.trim();
  }

  const result = await executeGatewayPlugin(
    executionService,
    "git_create_pull_request",
    payload,
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: buildGitActivityMetadata("Creating pull request", {
      preview: `${validatedInput.owner.trim()}/${validatedInput.repo.trim()} - ${validatedInput.title.trim()}`,
      pluginLabel: "GitHub",
    }),
  });
}

async function executeGitBranchCreateTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput(
    "git_branch_create",
    taskInput,
  );
  const result = await executeGatewayPlugin(
    executionService,
    "git_branch_create",
    {
      branch: validatedInput.branch.trim(),
    },
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: buildGitActivityMetadata("Creating branch", {
      branch: validatedInput.branch.trim(),
      preview: validatedInput.branch.trim(),
    }),
  });
}

async function executeGitBranchSwitchTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput(
    "git_branch_switch",
    taskInput,
  );
  const result = await executeGatewayPlugin(
    executionService,
    "git_branch_switch",
    {
      branch: validatedInput.branch.trim(),
    },
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: buildGitActivityMetadata("Switching branch", {
      branch: validatedInput.branch.trim(),
      preview: validatedInput.branch.trim(),
    }),
  });
}

async function executeGitDiffTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput("git_diff", taskInput);
  const payload: Record<string, unknown> = {};

  if (validatedInput.path) {
    const path = normalizeToolPath(validatedInput.path);
    validateSafePath(path);
    payload.path = path;
  }
  if (typeof validatedInput.staged === "boolean") {
    payload.staged = validatedInput.staged;
  }

  const result = await executeGatewayPlugin(
    executionService,
    "git_diff",
    payload,
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result));
}

async function executeGitHubPullRequestGetTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput(
    "github_pr_get",
    taskInput,
  );
  return executeGitHubReadTool(executionService, taskId, "github_pr_get", {
    owner: validatedInput.owner.trim(),
    repo: validatedInput.repo.trim(),
    number: validatedInput.number,
  });
}

async function executeGitHubPullRequestListTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput(
    "github_pr_list",
    taskInput,
  );
  return executeGitHubReadTool(executionService, taskId, "github_pr_list", {
    owner: validatedInput.owner.trim(),
    repo: validatedInput.repo.trim(),
    state: validatedInput.state,
    head: validatedInput.head?.trim(),
  });
}

async function executeGitHubPullRequestChecksGetTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput(
    "github_pr_checks_get",
    taskInput,
  );
  return executeGitHubReadTool(
    executionService,
    taskId,
    "github_pr_checks_get",
    {
      owner: validatedInput.owner.trim(),
      repo: validatedInput.repo.trim(),
      number: validatedInput.number,
    },
  );
}

async function executeGitHubReviewThreadsGetTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput(
    "github_review_threads_get",
    taskInput,
  );
  return executeGitHubReadTool(
    executionService,
    taskId,
    "github_review_threads_get",
    {
      owner: validatedInput.owner.trim(),
      repo: validatedInput.repo.trim(),
      number: validatedInput.number,
    },
  );
}

async function executeGitHubIssueGetTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput(
    "github_issue_get",
    taskInput,
  );
  return executeGitHubReadTool(executionService, taskId, "github_issue_get", {
    owner: validatedInput.owner.trim(),
    repo: validatedInput.repo.trim(),
    number: validatedInput.number,
  });
}

async function executeGitHubActionsRunGetTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput(
    "github_actions_run_get",
    taskInput,
  );
  return executeGitHubReadTool(
    executionService,
    taskId,
    "github_actions_run_get",
    {
      owner: validatedInput.owner.trim(),
      repo: validatedInput.repo.trim(),
      actionsRunId: validatedInput.actionsRunId,
    },
  );
}

async function executeGitHubActionsJobLogsGetTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput(
    "github_actions_job_logs_get",
    taskInput,
  );
  return executeGitHubReadTool(
    executionService,
    taskId,
    "github_actions_job_logs_get",
    {
      owner: validatedInput.owner.trim(),
      repo: validatedInput.repo.trim(),
      actionsJobId: validatedInput.actionsJobId,
      tailLines: validatedInput.tailLines,
    },
  );
}

async function executeGitHubCliPullRequestChecksGetTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const flags = readGitHubCliRuntimeFlags(taskInput);
  const validatedInput = validateGoldenFlowToolInput(
    "github_cli_pr_checks_get",
    taskInput,
  );
  return executeGitHubCliReadTool(
    executionService,
    taskId,
    "github_cli_pr_checks_get",
    flags,
    {
      owner: validatedInput.owner.trim(),
      repo: validatedInput.repo.trim(),
      number: validatedInput.number,
    },
  );
}

async function executeGitHubCliActionsRunGetTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const flags = readGitHubCliRuntimeFlags(taskInput);
  const validatedInput = validateGoldenFlowToolInput(
    "github_cli_actions_run_get",
    taskInput,
  );
  return executeGitHubCliReadTool(
    executionService,
    taskId,
    "github_cli_actions_run_get",
    flags,
    {
      owner: validatedInput.owner.trim(),
      repo: validatedInput.repo.trim(),
      actionsRunId: validatedInput.actionsRunId,
    },
  );
}

async function executeGitHubCliActionsJobLogsGetTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const flags = readGitHubCliRuntimeFlags(taskInput);
  const validatedInput = validateGoldenFlowToolInput(
    "github_cli_actions_job_logs_get",
    taskInput,
  );
  return executeGitHubCliReadTool(
    executionService,
    taskId,
    "github_cli_actions_job_logs_get",
    flags,
    {
      owner: validatedInput.owner.trim(),
      repo: validatedInput.repo.trim(),
      actionsJobId: validatedInput.actionsJobId,
      tailLines: validatedInput.tailLines,
    },
  );
}

async function executeGitHubCliPullRequestCommentTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const flags = readGitHubCliRuntimeFlags(taskInput);
  const validatedInput = validateGoldenFlowToolInput(
    "github_cli_pr_comment",
    taskInput,
  );
  return executeGitHubCliMutationTool(
    executionService,
    taskId,
    "github_cli_pr_comment",
    flags,
    {
      owner: validatedInput.owner.trim(),
      repo: validatedInput.repo.trim(),
      number: validatedInput.number,
      body: validatedInput.body.trim(),
    },
  );
}

async function executeGitHubReadTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  toolName:
    | "github_pr_list"
    | "github_pr_get"
    | "github_pr_checks_get"
    | "github_review_threads_get"
    | "github_issue_get"
    | "github_actions_run_get"
    | "github_actions_job_logs_get",
  payload: Record<string, unknown>,
): Promise<TaskResult> {
  const result = await executeGatewayPlugin(
    executionService,
    toolName,
    payload,
  );
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure, {
      activity: {
        displayText: "Reading GitHub metadata",
        summary: `${toolName} failed`,
      },
    });
  }

  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: {
      displayText: "Reading GitHub metadata",
      summary: `${toolName} completed`,
    },
  });
}

async function executeGitHubCliReadTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  toolName:
    | "github_cli_pr_checks_get"
    | "github_cli_actions_run_get"
    | "github_cli_actions_job_logs_get",
  flags: GitHubCliRuntimeFlags,
  payload: Record<string, unknown>,
): Promise<TaskResult> {
  const laneFailure = getDisabledGitHubCliToolFailure(toolName, flags);
  if (laneFailure) {
    return buildFailureResult(taskId, laneFailure);
  }

  const result = await executeGatewayPlugin(executionService, toolName, {
    ...payload,
    ...toGitHubCliFlagPayload(flags),
  });
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure, {
      activity: {
        displayText: "Reading GitHub metadata via CLI lane",
        summary: `${toolName} failed`,
      },
    });
  }

  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: {
      displayText: "Reading GitHub metadata via CLI lane",
      summary: `${toolName} completed`,
    },
  });
}

async function executeGitHubCliMutationTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  toolName: "github_cli_pr_comment",
  flags: GitHubCliRuntimeFlags,
  payload: Record<string, unknown>,
): Promise<TaskResult> {
  const laneFailure = getDisabledGitHubCliToolFailure(toolName, flags);
  if (laneFailure) {
    return buildFailureResult(taskId, laneFailure);
  }

  const result = await executeGatewayPlugin(executionService, toolName, {
    ...payload,
    ...toGitHubCliFlagPayload(flags),
  });
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure, {
      activity: {
        displayText: "Writing GitHub metadata via CLI lane",
        summary: `${toolName} failed`,
      },
    });
  }

  return buildSuccessResult(taskId, formatExecutionResult(result), {
    activity: {
      displayText: "Writing GitHub metadata via CLI lane",
      summary: `${toolName} completed`,
    },
  });
}

async function executeGlobTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput("glob", taskInput);
  const startPath = validatedInput.path ?? ".";
  if (startPath !== ".") {
    validateSafePath(startPath);
  }

  const payload: Record<string, unknown> = {
    pattern: validatedInput.pattern,
    path: startPath,
  };
  if (validatedInput.maxResults !== undefined) {
    payload.maxResults = validatedInput.maxResults;
  }

  const result = await executeGatewayPlugin(executionService, "glob", payload);
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result));
}

async function executeGrepTool(
  executionService: RuntimeExecutionService,
  taskId: string,
  taskInput: TaskInput,
): Promise<TaskResult> {
  const validatedInput = validateGoldenFlowToolInput("grep", taskInput);
  const startPath = validatedInput.path ?? ".";
  if (startPath !== ".") {
    validateSafePath(startPath);
  }

  const payload: Record<string, unknown> = {
    pattern: validatedInput.pattern,
    path: startPath,
  };
  if (validatedInput.glob) {
    payload.glob = validatedInput.glob;
  }
  if (validatedInput.caseSensitive !== undefined) {
    payload.caseSensitive = validatedInput.caseSensitive;
  }
  if (validatedInput.maxResults !== undefined) {
    payload.maxResults = validatedInput.maxResults;
  }

  const result = await executeGatewayPlugin(executionService, "grep", payload);
  const failure = extractExecutionFailure(result);
  if (failure) {
    return buildFailureResult(taskId, failure);
  }
  return buildSuccessResult(taskId, formatExecutionResult(result));
}

interface GitHubCliRuntimeFlags {
  laneEnabled: boolean;
  ciEnabled: boolean;
  prCommentEnabled: boolean;
}

function readGitHubCliRuntimeFlags(
  taskInput: TaskInput,
): GitHubCliRuntimeFlags {
  const rawFlags = taskInput[INTERNAL_RUNTIME_FEATURE_FLAGS_KEY];
  if (!rawFlags || typeof rawFlags !== "object") {
    return {
      laneEnabled: false,
      ciEnabled: false,
      prCommentEnabled: false,
    };
  }

  const flags = rawFlags as Record<string, unknown>;
  const laneEnabled = readBoolean(flags.ghCliLaneEnabled) ?? false;
  const ciEnabled = readBoolean(flags.ghCliCiEnabled) ?? false;
  const prCommentEnabled = readBoolean(flags.ghCliPrCommentEnabled) ?? false;
  return {
    laneEnabled,
    ciEnabled,
    prCommentEnabled,
  };
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getDisabledGitHubCliToolFailure(
  toolName:
    | "github_cli_pr_checks_get"
    | "github_cli_actions_run_get"
    | "github_cli_actions_job_logs_get"
    | "github_cli_pr_comment",
  flags: GitHubCliRuntimeFlags,
): string | null {
  if (!flags.laneEnabled) {
    return "GitHub CLI lane is disabled by feature flag GH_CLI_LANE_ENABLED.";
  }

  if (
    (toolName === "github_cli_pr_checks_get" ||
      toolName === "github_cli_actions_run_get" ||
      toolName === "github_cli_actions_job_logs_get") &&
    !flags.ciEnabled
  ) {
    return "GitHub CLI CI lane is disabled by feature flag GH_CLI_CI_ENABLED.";
  }

  if (toolName === "github_cli_pr_comment" && !flags.prCommentEnabled) {
    return "GitHub CLI PR comment mutation is disabled by feature flag GH_CLI_PR_COMMENT_ENABLED.";
  }

  return null;
}

function toGitHubCliFlagPayload(flags: GitHubCliRuntimeFlags): {
  ghCliLaneEnabled: boolean;
  ghCliCiEnabled: boolean;
  ghCliPrCommentEnabled: boolean;
} {
  return {
    ghCliLaneEnabled: flags.laneEnabled,
    ghCliCiEnabled: flags.ciEnabled,
    ghCliPrCommentEnabled: flags.prCommentEnabled,
  };
}

async function executeGatewayPlugin(
  executionService: RuntimeExecutionService,
  toolName: GoldenFlowToolName,
  payload: Record<string, unknown>,
  options?: {
    onOutput?: (chunk: ExecutionOutputChunk) => Promise<void> | void;
  },
): Promise<unknown> {
  const route = getGoldenFlowToolRoute(toolName);
  if (!route || route.plugin === "internal") {
    throw new Error(`No executable gateway route registered for ${toolName}`);
  }
  return executionService.execute(route.plugin, route.action, payload, options);
}

async function readExistingFileContent(
  executionService: RuntimeExecutionService,
  path: string,
): Promise<string> {
  const result = await executeGatewayPlugin(executionService, "read_file", {
    path,
  });
  const failure = extractExecutionFailure(result);
  if (failure) {
    return "";
  }
  return formatExecutionResult(result);
}

function buildSuccessResult(
  taskId: string,
  content: string,
  metadata?: Record<string, unknown>,
): TaskResult {
  return {
    taskId,
    status: "DONE",
    output: {
      content,
      metadata,
    },
    completedAt: new Date(),
  };
}

function buildFailureResult(
  taskId: string,
  message: string,
  metadata?: Record<string, unknown>,
): TaskResult {
  return {
    taskId,
    status: "FAILED",
    error: { message },
    output: metadata
      ? {
          content: message,
          metadata,
        }
      : undefined,
    completedAt: new Date(),
  };
}

function isGitCommitIdentityConfigShellCommand(command: string): boolean {
  const commandSegments = splitShellCommandSegments(command);
  return commandSegments.some((segment) =>
    GIT_COMMIT_IDENTITY_CONFIG_SEGMENT_PATTERN.test(segment),
  );
}

function isGitShellCommand(command: string): boolean {
  const commandSegments = splitShellCommandSegments(command);
  return commandSegments.some((segment) => {
    const withoutEnvAssignments = segment.replace(
      /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/,
      "",
    );
    return /^git(?:\s|$)/i.test(withoutEnvAssignments.trim());
  });
}

function splitShellCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function buildWriteActivityMetadata(
  path: string,
  previousContent: string,
  nextContent: string,
): Record<string, unknown> {
  const additions = countChangedLines(nextContent, previousContent);
  const deletions = countChangedLines(previousContent, nextContent);
  return {
    family: "edit",
    filePath: path,
    additions,
    deletions,
    diffPreview: buildDiffPreview(previousContent, nextContent),
    restorationContent: nextContent,
  };
}

function buildGitActivityMetadata(
  displayText: string,
  input: {
    branch?: string;
    preview?: string;
    pluginLabel?: string;
    commitIdentitySource?: GitCommitIdentitySource;
    commitIdentityVerified?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    family: "git",
    displayText,
    pluginLabel: input.pluginLabel ?? "GitHub",
    branch: input.branch,
    preview: input.preview,
    commitIdentitySource: input.commitIdentitySource,
    commitIdentityVerified: input.commitIdentityVerified,
  };
}

function readCommitIdentityEvidence(result: unknown): {
  source?: GitCommitIdentitySource;
  verified?: boolean;
} {
  if (!isRecord(result)) {
    return {};
  }

  const output = isRecord(result.output) ? result.output : null;
  const commitIdentity =
    output && isRecord(output.commitIdentity) ? output.commitIdentity : null;
  if (!commitIdentity) {
    return {};
  }

  const source = readGitCommitIdentitySource(commitIdentity.source);
  const verified =
    typeof commitIdentity.verified === "boolean"
      ? commitIdentity.verified
      : undefined;
  return {
    source,
    verified,
  };
}

function readGitCommitIdentitySource(
  value: unknown,
): GitCommitIdentitySource | undefined {
  if (
    value === "workspace_git_config" ||
    value === "github_profile" ||
    value === "user_input"
  ) {
    return value;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createShellState(input: {
  command: string;
  cwd: string;
  description?: string;
}) {
  return {
    command: input.command,
    cwd: input.cwd,
    description: input.description,
    stdout: "",
    stderr: "",
    truncated: false,
  };
}

function appendShellState(
  state: {
    stdout: string;
    stderr: string;
    truncated: boolean;
  },
  chunk: ExecutionOutputChunk,
): void {
  const targetKey = chunk.source === "stderr" ? "stderr" : "stdout";
  const nextValue = `${state[targetKey]}${chunk.message}`;
  const cappedValue = nextValue.length > 64 * 1024;
  state[targetKey] = cappedValue
    ? nextValue.slice(nextValue.length - 64 * 1024)
    : nextValue;
  state.truncated = state.truncated || cappedValue;
}

function buildShellActivityMetadata(
  state: {
    command: string;
    cwd: string;
    description?: string;
    stdout: string;
    stderr: string;
    truncated: boolean;
  },
  exitCode: number,
): Record<string, unknown> {
  return {
    family: "shell",
    command: state.command,
    description: state.description,
    cwd: state.cwd,
    origin: "agent_tool",
    stdout: state.stdout || undefined,
    stderr: state.stderr || undefined,
    outputTail: buildShellOutputTail(state.stdout, state.stderr) || undefined,
    exitCode,
    truncated: state.truncated,
  };
}

function buildShellOutputTail(stdout: string, stderr: string): string {
  const sections: string[] = [];
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (trimmedStdout) {
    sections.push(trimmedStdout);
  }
  if (trimmedStderr) {
    sections.push(`[stderr]\n${trimmedStderr}`);
  }

  const combined = sections.join("\n");
  if (combined.length <= 128 * 1024) {
    return combined;
  }
  return combined.slice(combined.length - 128 * 1024);
}

function countChangedLines(source: string, comparison: string): number {
  const sourceLines = splitLines(source);
  const comparisonLines = new Set(splitLines(comparison));
  return sourceLines.filter((line) => !comparisonLines.has(line)).length;
}

function buildDiffPreview(
  previousContent: string,
  nextContent: string,
): string {
  const previousLines = splitLines(previousContent);
  const nextLines = splitLines(nextContent);
  const previewLines: string[] = [];

  for (const line of nextLines) {
    if (!previousLines.includes(line)) {
      previewLines.push(`+ ${line}`);
    }
    if (previewLines.length >= 6) {
      break;
    }
  }

  for (const line of previousLines) {
    if (!nextLines.includes(line)) {
      previewLines.push(`- ${line}`);
    }
    if (previewLines.length >= 10) {
      break;
    }
  }

  return previewLines.join("\n");
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function normalizeToolPath(input: string): string {
  const trimmed = input.trim().replace(/^['"`]+|['"`]+$/g, "");
  const withoutMention = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const cleaned = withoutMention.replace(/[?!,;:]+$/g, "");
  const aliases: Record<string, string> = {
    readme: "README.md",
    "readme.md": "README.md",
  };
  return aliases[cleaned.toLowerCase()] ?? cleaned;
}

export function normalizeWorkspacePath(input: string): string {
  const trimmed = input.trim().replace(/^['"`]+/, "");
  const cleaned = trimmed.replace(/['"`?!,;:]+$/g, "");
  const aliases: Record<string, string> = {
    readme: "README.md",
    "readme.md": "README.md",
  };
  return aliases[cleaned.toLowerCase()] ?? cleaned;
}

function validateToolPath(path: string): void {
  if (!isConcretePathInput(path)) {
    throw new Error("Task path must be a concrete non-empty file path");
  }
}

function extractDirectoryFromLsCommand(command: string): string {
  const segments = command.split(/\s+/).slice(1);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment || segment.startsWith("-")) {
      continue;
    }
    return segment;
  }
  return ".";
}

function extractPathFromCatCommand(command: string): string | null {
  const trimmed = command.trim();
  const match = trimmed.match(/^cat\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }

  const argument = match[1].trim();
  if (!argument || /[|;&><]/.test(argument) || /\s/.test(argument)) {
    return null;
  }

  if (argument.startsWith("-")) {
    return null;
  }

  return argument;
}
