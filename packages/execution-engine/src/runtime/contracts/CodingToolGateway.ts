import type { CoreTool } from "ai";
import { z } from "zod";
import {
  CODING_TOOL_IDS,
  GLOB_TOOL_INPUT_SCHEMA,
  GREP_TOOL_INPUT_SCHEMA,
  READ_FILE_TOOL_INPUT_SCHEMA,
  LIST_FILES_TOOL_INPUT_SCHEMA,
  WRITE_FILE_TOOL_INPUT_SCHEMA,
  BASH_TOOL_INPUT_SCHEMA,
  GIT_STAGE_TOOL_INPUT_SCHEMA,
  GIT_COMMIT_TOOL_INPUT_SCHEMA,
  GIT_PUSH_TOOL_INPUT_SCHEMA,
  GIT_PULL_TOOL_INPUT_SCHEMA,
  GIT_CREATE_PULL_REQUEST_TOOL_INPUT_SCHEMA,
  GIT_BRANCH_CREATE_TOOL_INPUT_SCHEMA,
  GIT_BRANCH_SWITCH_TOOL_INPUT_SCHEMA,
  GIT_STATUS_TOOL_INPUT_SCHEMA,
  GIT_DIFF_TOOL_INPUT_SCHEMA,
  GITHUB_PR_GET_TOOL_INPUT_SCHEMA,
  GITHUB_PR_LIST_TOOL_INPUT_SCHEMA,
  GITHUB_ACTIONS_RUN_GET_TOOL_INPUT_SCHEMA,
  GITHUB_ACTIONS_JOB_LOGS_GET_TOOL_INPUT_SCHEMA,
  GITHUB_CLI_PR_COMMENT_TOOL_INPUT_SCHEMA,
  getCodingCoreToolRegistry,
  getCodingToolDefinition,
  isCodingToolId,
  type CodingToolId,
  type ToolGatewayRoute,
} from "../tools/CodingToolRegistry.js";
import {
  buildToolCatalogSnapshot,
  createCloudSandboxRunCapabilityManifest,
  type RunCapabilityManifest,
  type RunCapabilityManifestInput,
  type ToolCatalogSnapshot,
} from "../capabilities/index.js";

export {
  getCodingToolDefinition,
  getCodingToolDefinitions,
  isCodingToolId,
  type ToolDefinition,
  type ToolResult,
} from "../tools/CodingToolRegistry.js";

export type GoldenFlowToolName = CodingToolId;
export type { ToolGatewayRoute };

export type GoldenFlowToolInputByName = {
  read_file: z.infer<typeof READ_FILE_TOOL_INPUT_SCHEMA>;
  list_files: z.infer<typeof LIST_FILES_TOOL_INPUT_SCHEMA>;
  write_file: z.infer<typeof WRITE_FILE_TOOL_INPUT_SCHEMA>;
  bash: z.infer<typeof BASH_TOOL_INPUT_SCHEMA>;
  git_stage: z.infer<typeof GIT_STAGE_TOOL_INPUT_SCHEMA>;
  git_commit: z.infer<typeof GIT_COMMIT_TOOL_INPUT_SCHEMA>;
  git_push: z.infer<typeof GIT_PUSH_TOOL_INPUT_SCHEMA>;
  git_pull: z.infer<typeof GIT_PULL_TOOL_INPUT_SCHEMA>;
  git_create_pull_request: z.infer<
    typeof GIT_CREATE_PULL_REQUEST_TOOL_INPUT_SCHEMA
  >;
  git_branch_create: z.infer<typeof GIT_BRANCH_CREATE_TOOL_INPUT_SCHEMA>;
  git_branch_switch: z.infer<typeof GIT_BRANCH_SWITCH_TOOL_INPUT_SCHEMA>;
  git_status: z.infer<typeof GIT_STATUS_TOOL_INPUT_SCHEMA>;
  git_diff: z.infer<typeof GIT_DIFF_TOOL_INPUT_SCHEMA>;
  github_pr_list: z.infer<typeof GITHUB_PR_LIST_TOOL_INPUT_SCHEMA>;
  github_pr_get: z.infer<typeof GITHUB_PR_GET_TOOL_INPUT_SCHEMA>;
  github_pr_checks_get: z.infer<typeof GITHUB_PR_GET_TOOL_INPUT_SCHEMA>;
  github_review_threads_get: z.infer<typeof GITHUB_PR_GET_TOOL_INPUT_SCHEMA>;
  github_issue_get: z.infer<typeof GITHUB_PR_GET_TOOL_INPUT_SCHEMA>;
  github_actions_run_get: z.infer<
    typeof GITHUB_ACTIONS_RUN_GET_TOOL_INPUT_SCHEMA
  >;
  github_actions_job_logs_get: z.infer<
    typeof GITHUB_ACTIONS_JOB_LOGS_GET_TOOL_INPUT_SCHEMA
  >;
  github_cli_pr_checks_get: z.infer<typeof GITHUB_PR_GET_TOOL_INPUT_SCHEMA>;
  github_cli_actions_run_get: z.infer<
    typeof GITHUB_ACTIONS_RUN_GET_TOOL_INPUT_SCHEMA
  >;
  github_cli_actions_job_logs_get: z.infer<
    typeof GITHUB_ACTIONS_JOB_LOGS_GET_TOOL_INPUT_SCHEMA
  >;
  github_cli_pr_comment: z.infer<
    typeof GITHUB_CLI_PR_COMMENT_TOOL_INPUT_SCHEMA
  >;
  glob: z.infer<typeof GLOB_TOOL_INPUT_SCHEMA>;
  grep: z.infer<typeof GREP_TOOL_INPUT_SCHEMA>;
};

// TODO(75-tool-floor-deferred): keep deferred tools out of the canonical floor for phase A.
// Deferred: web_fetch, web_search, ask_user_question/request_user_input, notebook_edit, todo_write,
// enter_worktree/exit_worktree, task_output/task_stop, config, skill, agent, enterprise permission overlays.

export function getGoldenFlowToolNames(): GoldenFlowToolName[] {
  return [...CODING_TOOL_IDS];
}

export function isGoldenFlowToolName(
  value: string,
): value is GoldenFlowToolName {
  return isCodingToolId(value);
}

export function isMutatingGoldenFlowToolName(toolName: string): boolean {
  const definition = getCodingToolDefinition(toolName);
  return definition?.permission.mode === "approval_required";
}

export function getGoldenFlowToolRoute(
  toolName: string,
): ToolGatewayRoute | null {
  const definition = getCodingToolDefinition(toolName);
  return definition ? { ...definition.route } : null;
}

export function getGoldenFlowToolRegistry(): Record<string, CoreTool> {
  return getCodingCoreToolRegistry();
}

export function getGoldenFlowRunCapabilityManifest(
  input: RunCapabilityManifestInput & { availableToolIds: readonly string[] },
): RunCapabilityManifest {
  return createCloudSandboxRunCapabilityManifest(input);
}

export function getGoldenFlowToolCatalogSnapshot(
  input: RunCapabilityManifestInput & { availableToolIds: readonly string[] },
): ToolCatalogSnapshot {
  return buildToolCatalogSnapshot(getGoldenFlowRunCapabilityManifest(input));
}

export function enforceGoldenFlowToolFloor(
  incomingTools: Record<string, CoreTool>,
  metadata?: Record<string, unknown>,
): Record<string, CoreTool> {
  const constrained: Record<string, CoreTool> = {};
  const githubCliFlags = resolveGitHubCliFlags(metadata);
  for (const toolName of CODING_TOOL_IDS) {
    if (!isGoldenFlowToolEnabledByFlags(toolName, githubCliFlags)) {
      continue;
    }
    const incoming = incomingTools[toolName];
    if (incoming) {
      constrained[toolName] = incoming;
    }
  }
  return constrained;
}

export function validateGoldenFlowToolInput<T extends GoldenFlowToolName>(
  toolName: T,
  input: unknown,
): GoldenFlowToolInputByName[T] {
  const definition = getCodingToolDefinition(toolName);
  if (!definition) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const parsed = definition.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid ${toolName} input. ${formatIssues(parsed.error)}`);
  }
  return parsed.data as GoldenFlowToolInputByName[T];
}

interface GitHubCliLaneFlags {
  laneEnabled: boolean;
  ciEnabled: boolean;
  prCommentEnabled: boolean;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

function resolveGitHubCliFlags(
  metadata: Record<string, unknown> | undefined,
): GitHubCliLaneFlags {
  const featureFlags =
    metadata?.featureFlags && typeof metadata.featureFlags === "object"
      ? (metadata.featureFlags as Record<string, unknown>)
      : undefined;

  return {
    laneEnabled: readBoolean(featureFlags?.ghCliLaneEnabled) ?? false,
    ciEnabled: readBoolean(featureFlags?.ghCliCiEnabled) ?? false,
    prCommentEnabled: readBoolean(featureFlags?.ghCliPrCommentEnabled) ?? false,
  };
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isGoldenFlowToolEnabledByFlags(
  toolName: GoldenFlowToolName,
  flags: GitHubCliLaneFlags,
): boolean {
  if (toolName === "github_cli_pr_comment") {
    return flags.laneEnabled && flags.prCommentEnabled;
  }

  if (
    toolName === "github_cli_pr_checks_get" ||
    toolName === "github_cli_actions_run_get" ||
    toolName === "github_cli_actions_job_logs_get"
  ) {
    return flags.laneEnabled && flags.ciEnabled;
  }

  return true;
}
