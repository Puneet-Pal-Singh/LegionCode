import type { CoreTool } from "ai";
import { z } from "zod";

export const MAX_TOOL_PATH_LENGTH = 500;
export const MAX_TOOL_COMMAND_LENGTH = 500;
export const MAX_TOOL_PATTERN_LENGTH = 200;
export const MAX_TOOL_WRITE_CONTENT_LENGTH = 200_000;
export const MAX_TOOL_SEARCH_RESULTS = 200;
export const MAX_TOOL_READ_LINES = 1_000;

export type ToolSandboxClass =
  | "read"
  | "write"
  | "shell"
  | "network"
  | "git"
  | "approval";

export interface ToolPermissionPolicy {
  mode: "allow" | "approval_required" | "deny";
  scope: "workspace" | "remote" | "repository";
}

export interface ToolTokenPolicy {
  maxOutputBytes: number;
  maxLineBytes?: number;
  maxResults?: number;
  continuationHint?: string;
}

export type ToolOutputRenderer =
  | "text"
  | "json"
  | "diff"
  | "shell"
  | "git"
  | "github";

export interface ToolArtifact {
  title: string;
  kind: "file" | "diff" | "log";
  path?: string;
  content?: string;
}

export interface ToolDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
}

export interface ToolResult {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
  artifacts?: ToolArtifact[];
  diagnostics?: ToolDiagnostic[];
  truncated: boolean;
}

export interface ToolGatewayRoute {
  toolName: CodingToolId;
  plugin:
    | "filesystem"
    | "node"
    | "git"
    | "github"
    | "github_cli"
    | "bash"
    | "internal";
  action: string;
}

export interface ToolExecutionContext {
  execute(
    plugin: ToolGatewayRoute["plugin"],
    action: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface ToolDefinition {
  id: CodingToolId;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  permission: ToolPermissionPolicy;
  sandboxClass: ToolSandboxClass;
  tokenPolicy: ToolTokenPolicy;
  outputRenderer: ToolOutputRenderer;
  route: ToolGatewayRoute;
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

function createToolInputSchema<TShape extends z.ZodRawShape>(
  shape: TShape,
  options: { allowNullishEmptyObject?: boolean } = {},
) {
  const baseSchema = z.object(shape);
  if (!options.allowNullishEmptyObject) {
    return baseSchema;
  }

  return z.preprocess((value) => (value == null ? {} : value), baseSchema);
}

export const READ_FILE_TOOL_INPUT_SCHEMA = createToolInputSchema({
  path: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_TOOL_READ_LINES).optional(),
});

export const LIST_FILES_TOOL_INPUT_SCHEMA = createToolInputSchema(
  {
    path: z.string().max(MAX_TOOL_PATH_LENGTH).optional(),
  },
  { allowNullishEmptyObject: true },
);

export const WRITE_FILE_TOOL_INPUT_SCHEMA = createToolInputSchema({
  path: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  content: z.string().min(1).max(MAX_TOOL_WRITE_CONTENT_LENGTH),
});

export const BASH_TOOL_INPUT_SCHEMA = createToolInputSchema({
  command: z.string().min(1).max(MAX_TOOL_COMMAND_LENGTH),
  cwd: z.string().min(1).max(MAX_TOOL_PATH_LENGTH).optional(),
  description: z.string().min(1).max(MAX_TOOL_COMMAND_LENGTH).optional(),
});

export const GIT_STAGE_TOOL_INPUT_SCHEMA = createToolInputSchema(
  {
    files: z.array(z.string().min(1).max(MAX_TOOL_PATH_LENGTH)).optional(),
  },
  { allowNullishEmptyObject: true },
);

export const GIT_COMMIT_TOOL_INPUT_SCHEMA = createToolInputSchema({
  message: z
    .string()
    .min(1)
    .max(MAX_TOOL_COMMAND_LENGTH)
    .refine((value) => !/[\r\n\0]/.test(value), {
      message: "Commit message must be a single-line subject",
    }),
  files: z.array(z.string().min(1).max(MAX_TOOL_PATH_LENGTH)).optional(),
  authorName: z.string().min(1).max(MAX_TOOL_COMMAND_LENGTH).optional(),
  authorEmail: z.string().min(1).max(MAX_TOOL_COMMAND_LENGTH).optional(),
});

export const GIT_PUSH_TOOL_INPUT_SCHEMA = createToolInputSchema(
  {
    remote: z.string().min(1).max(MAX_TOOL_PATH_LENGTH).optional(),
    branch: z.string().min(1).max(MAX_TOOL_PATH_LENGTH).optional(),
  },
  { allowNullishEmptyObject: true },
);

export const GIT_PULL_TOOL_INPUT_SCHEMA = GIT_PUSH_TOOL_INPUT_SCHEMA;

export const GIT_CREATE_PULL_REQUEST_TOOL_INPUT_SCHEMA = createToolInputSchema({
  owner: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  repo: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  title: z.string().min(1).max(MAX_TOOL_COMMAND_LENGTH),
  body: z.string().max(MAX_TOOL_WRITE_CONTENT_LENGTH).optional(),
  base: z.string().min(1).max(MAX_TOOL_PATH_LENGTH).optional(),
});

export const GIT_BRANCH_CREATE_TOOL_INPUT_SCHEMA = createToolInputSchema({
  branch: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
});

export const GIT_BRANCH_SWITCH_TOOL_INPUT_SCHEMA = GIT_BRANCH_CREATE_TOOL_INPUT_SCHEMA;

export const GIT_STATUS_TOOL_INPUT_SCHEMA = createToolInputSchema(
  {},
  { allowNullishEmptyObject: true },
);

export const GIT_DIFF_TOOL_INPUT_SCHEMA = createToolInputSchema(
  {
    path: z.string().min(1).max(MAX_TOOL_PATH_LENGTH).optional(),
    staged: z.boolean().optional(),
  },
  { allowNullishEmptyObject: true },
);

export const GITHUB_PR_GET_TOOL_INPUT_SCHEMA = createToolInputSchema({
  owner: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  repo: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  number: z.number().int().positive(),
});

export const GITHUB_PR_LIST_TOOL_INPUT_SCHEMA = createToolInputSchema({
  owner: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  repo: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  state: z.enum(["open", "closed", "all"]).optional(),
  head: z.string().min(1).max(MAX_TOOL_PATH_LENGTH).optional(),
});

export const GITHUB_ACTIONS_RUN_GET_TOOL_INPUT_SCHEMA = createToolInputSchema({
  owner: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  repo: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  actionsRunId: z.number().int().positive(),
});

export const GITHUB_ACTIONS_JOB_LOGS_GET_TOOL_INPUT_SCHEMA = createToolInputSchema({
  owner: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  repo: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  actionsJobId: z.number().int().positive(),
  tailLines: z.number().int().min(1).max(2_000).optional(),
});

export const GITHUB_CLI_PR_COMMENT_TOOL_INPUT_SCHEMA = createToolInputSchema({
  owner: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  repo: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  number: z.number().int().positive(),
  body: z.string().min(1).max(MAX_TOOL_WRITE_CONTENT_LENGTH),
});

export const GLOB_TOOL_INPUT_SCHEMA = createToolInputSchema({
  pattern: z.string().min(1).max(MAX_TOOL_PATTERN_LENGTH),
  path: z.string().min(1).max(MAX_TOOL_PATH_LENGTH).optional(),
  maxResults: z.number().int().min(1).max(MAX_TOOL_SEARCH_RESULTS).optional(),
});

export const GREP_TOOL_INPUT_SCHEMA = createToolInputSchema({
  pattern: z.string().min(1).max(MAX_TOOL_PATTERN_LENGTH),
  path: z.string().min(1).max(MAX_TOOL_PATH_LENGTH).optional(),
  glob: z.string().min(1).max(MAX_TOOL_PATTERN_LENGTH).optional(),
  maxResults: z.number().int().min(1).max(MAX_TOOL_SEARCH_RESULTS).optional(),
  caseSensitive: z.boolean().optional(),
});

export const CODING_TOOL_IDS = [
  "read_file",
  "list_files",
  "write_file",
  "bash",
  "git_stage",
  "git_commit",
  "git_push",
  "git_pull",
  "git_create_pull_request",
  "git_branch_create",
  "git_branch_switch",
  "git_status",
  "git_diff",
  "github_pr_list",
  "github_pr_get",
  "github_pr_checks_get",
  "github_review_threads_get",
  "github_issue_get",
  "github_actions_run_get",
  "github_actions_job_logs_get",
  "github_cli_pr_checks_get",
  "github_cli_actions_run_get",
  "github_cli_actions_job_logs_get",
  "github_cli_pr_comment",
  "glob",
  "grep",
] as const;

export type CodingToolId = (typeof CODING_TOOL_IDS)[number];

const READ_TOKEN_POLICY: ToolTokenPolicy = {
  maxOutputBytes: 24_000,
  maxLineBytes: 500,
  maxResults: 200,
  continuationHint: "Use offset/limit or narrow the path/glob to continue.",
};

const WRITE_TOKEN_POLICY: ToolTokenPolicy = { maxOutputBytes: 4_000 };
const SHELL_TOKEN_POLICY: ToolTokenPolicy = { maxOutputBytes: 20_000 };
const GIT_TOKEN_POLICY: ToolTokenPolicy = { maxOutputBytes: 20_000 };
const REMOTE_TOKEN_POLICY: ToolTokenPolicy = { maxOutputBytes: 20_000 };

const WORKSPACE_READ_PERMISSION: ToolPermissionPolicy = {
  mode: "allow",
  scope: "workspace",
};

const WORKSPACE_WRITE_PERMISSION: ToolPermissionPolicy = {
  mode: "approval_required",
  scope: "workspace",
};

const REMOTE_READ_PERMISSION: ToolPermissionPolicy = {
  mode: "allow",
  scope: "remote",
};

const REPOSITORY_APPROVAL_PERMISSION: ToolPermissionPolicy = {
  mode: "approval_required",
  scope: "repository",
};

function createRoutedToolDefinition(input: {
  id: CodingToolId;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  permission: ToolPermissionPolicy;
  sandboxClass: ToolSandboxClass;
  tokenPolicy: ToolTokenPolicy;
  outputRenderer: ToolOutputRenderer;
  route: Omit<ToolGatewayRoute, "toolName">;
}): ToolDefinition {
  const route = { toolName: input.id, ...input.route };
  return {
    ...input,
    route,
    async execute(toolInput, context) {
      const result = await context.execute(route.plugin, route.action, toolInput);
      return adaptPluginResult(input.title, result);
    },
  };
}

function adaptPluginResult(title: string, result: unknown): ToolResult {
  if (isToolResult(result)) {
    return result;
  }
  if (isRecord(result) && result.success === false) {
    return buildFailedToolResult(title, result);
  }
  return buildSuccessfulToolResult(title, result);
}

function buildFailedToolResult(
  title: string,
  result: Record<string, unknown>,
): ToolResult {
  return {
    title,
    output: readString(result.error) ?? "Tool execution failed",
    metadata: { success: false },
    diagnostics: [{ severity: "error", message: "Tool execution failed" }],
    truncated: false,
  };
}

function buildSuccessfulToolResult(title: string, result: unknown): ToolResult {
  const output = isRecord(result) ? result.output : result;
  const metadata = isRecord(result) && isRecord(result.metadata)
    ? result.metadata
    : {};
  return {
    title,
    output: readString(output) ?? stringifyOutput(output),
    metadata,
    truncated: readBoolean(isRecord(result) ? result.truncated : undefined) ?? false,
  };
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.output === "string" &&
    isRecord(value.metadata) &&
    typeof value.truncated === "boolean"
  );
}

function stringifyOutput(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const CODING_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  createRoutedToolDefinition({
    id: "read_file",
    title: "Read File",
    description: "Read a capped text window from a workspace file.",
    inputSchema: READ_FILE_TOOL_INPUT_SCHEMA,
    permission: WORKSPACE_READ_PERMISSION,
    sandboxClass: "read",
    tokenPolicy: READ_TOKEN_POLICY,
    outputRenderer: "text",
    route: { plugin: "filesystem", action: "read_file" },
  }),
  createRoutedToolDefinition({
    id: "list_files",
    title: "List Files",
    description: "List files in a workspace directory.",
    inputSchema: LIST_FILES_TOOL_INPUT_SCHEMA,
    permission: WORKSPACE_READ_PERMISSION,
    sandboxClass: "read",
    tokenPolicy: READ_TOKEN_POLICY,
    outputRenderer: "text",
    route: { plugin: "filesystem", action: "list_files" },
  }),
  createRoutedToolDefinition({
    id: "write_file",
    title: "Write File",
    description: "Write content to a workspace file.",
    inputSchema: WRITE_FILE_TOOL_INPUT_SCHEMA,
    permission: WORKSPACE_WRITE_PERMISSION,
    sandboxClass: "write",
    tokenPolicy: WRITE_TOKEN_POLICY,
    outputRenderer: "text",
    route: { plugin: "filesystem", action: "write_file" },
  }),
  createRoutedToolDefinition({
    id: "bash",
    title: "Bash",
    description: "Run a bounded bash command in the current workspace.",
    inputSchema: BASH_TOOL_INPUT_SCHEMA,
    permission: WORKSPACE_WRITE_PERMISSION,
    sandboxClass: "shell",
    tokenPolicy: SHELL_TOKEN_POLICY,
    outputRenderer: "shell",
    route: { plugin: "bash", action: "run" },
  }),
  createRoutedToolDefinition({
    id: "git_stage",
    title: "Git Stage",
    description: "Stage workspace files with the dedicated git tool.",
    inputSchema: GIT_STAGE_TOOL_INPUT_SCHEMA,
    permission: REPOSITORY_APPROVAL_PERMISSION,
    sandboxClass: "git",
    tokenPolicy: GIT_TOKEN_POLICY,
    outputRenderer: "git",
    route: { plugin: "git", action: "git_stage" },
  }),
  createRoutedToolDefinition({
    id: "git_commit",
    title: "Git Commit",
    description: "Create a git commit with a conventional commit subject.",
    inputSchema: GIT_COMMIT_TOOL_INPUT_SCHEMA,
    permission: REPOSITORY_APPROVAL_PERMISSION,
    sandboxClass: "git",
    tokenPolicy: GIT_TOKEN_POLICY,
    outputRenderer: "git",
    route: { plugin: "git", action: "git_commit" },
  }),
  createRoutedToolDefinition({
    id: "git_push",
    title: "Git Push",
    description: "Push workspace commits with the dedicated git tool.",
    inputSchema: GIT_PUSH_TOOL_INPUT_SCHEMA,
    permission: REPOSITORY_APPROVAL_PERMISSION,
    sandboxClass: "git",
    tokenPolicy: GIT_TOKEN_POLICY,
    outputRenderer: "git",
    route: { plugin: "git", action: "git_push" },
  }),
  createRoutedToolDefinition({
    id: "git_pull",
    title: "Git Pull",
    description: "Sync the current branch from the remote.",
    inputSchema: GIT_PULL_TOOL_INPUT_SCHEMA,
    permission: REPOSITORY_APPROVAL_PERMISSION,
    sandboxClass: "git",
    tokenPolicy: GIT_TOKEN_POLICY,
    outputRenderer: "git",
    route: { plugin: "git", action: "git_pull" },
  }),
  createRoutedToolDefinition({
    id: "git_create_pull_request",
    title: "Create Pull Request",
    description: "Create a pull request for the current run workspace.",
    inputSchema: GIT_CREATE_PULL_REQUEST_TOOL_INPUT_SCHEMA,
    permission: REPOSITORY_APPROVAL_PERMISSION,
    sandboxClass: "git",
    tokenPolicy: GIT_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "git", action: "git_create_pull_request" },
  }),
  createRoutedToolDefinition({
    id: "git_branch_create",
    title: "Create Branch",
    description: "Create and switch to a new git branch.",
    inputSchema: GIT_BRANCH_CREATE_TOOL_INPUT_SCHEMA,
    permission: REPOSITORY_APPROVAL_PERMISSION,
    sandboxClass: "git",
    tokenPolicy: GIT_TOKEN_POLICY,
    outputRenderer: "git",
    route: { plugin: "git", action: "git_branch_create" },
  }),
  createRoutedToolDefinition({
    id: "git_branch_switch",
    title: "Switch Branch",
    description: "Switch to an existing git branch.",
    inputSchema: GIT_BRANCH_SWITCH_TOOL_INPUT_SCHEMA,
    permission: REPOSITORY_APPROVAL_PERMISSION,
    sandboxClass: "git",
    tokenPolicy: GIT_TOKEN_POLICY,
    outputRenderer: "git",
    route: { plugin: "git", action: "git_branch_switch" },
  }),
  createRoutedToolDefinition({
    id: "git_status",
    title: "Git Status",
    description: "Get git status for the workspace repository.",
    inputSchema: GIT_STATUS_TOOL_INPUT_SCHEMA,
    permission: WORKSPACE_READ_PERMISSION,
    sandboxClass: "git",
    tokenPolicy: GIT_TOKEN_POLICY,
    outputRenderer: "git",
    route: { plugin: "git", action: "git_status" },
  }),
  createRoutedToolDefinition({
    id: "git_diff",
    title: "Git Diff",
    description: "Get git diff for workspace changes.",
    inputSchema: GIT_DIFF_TOOL_INPUT_SCHEMA,
    permission: WORKSPACE_READ_PERMISSION,
    sandboxClass: "git",
    tokenPolicy: GIT_TOKEN_POLICY,
    outputRenderer: "diff",
    route: { plugin: "git", action: "git_diff" },
  }),
  createRoutedToolDefinition({
    id: "github_pr_list",
    title: "List Pull Requests",
    description: "List remote GitHub pull requests.",
    inputSchema: GITHUB_PR_LIST_TOOL_INPUT_SCHEMA,
    permission: REMOTE_READ_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github", action: "pr_list" },
  }),
  createRoutedToolDefinition({
    id: "github_pr_get",
    title: "Get Pull Request",
    description: "Get remote GitHub pull request metadata.",
    inputSchema: GITHUB_PR_GET_TOOL_INPUT_SCHEMA,
    permission: REMOTE_READ_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github", action: "pr_get" },
  }),
  createRoutedToolDefinition({
    id: "github_pr_checks_get",
    title: "Get PR Checks",
    description: "Get GitHub check runs for a pull request head commit.",
    inputSchema: GITHUB_PR_GET_TOOL_INPUT_SCHEMA,
    permission: REMOTE_READ_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github", action: "pr_checks_get" },
  }),
  createRoutedToolDefinition({
    id: "github_review_threads_get",
    title: "Get Review Threads",
    description: "Get pull request review thread metadata from GitHub.",
    inputSchema: GITHUB_PR_GET_TOOL_INPUT_SCHEMA,
    permission: REMOTE_READ_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github", action: "review_threads_get" },
  }),
  createRoutedToolDefinition({
    id: "github_issue_get",
    title: "Get Issue",
    description: "Get remote GitHub issue metadata.",
    inputSchema: GITHUB_PR_GET_TOOL_INPUT_SCHEMA,
    permission: REMOTE_READ_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github", action: "issue_get" },
  }),
  createRoutedToolDefinition({
    id: "github_actions_run_get",
    title: "Get Actions Run",
    description: "Get a GitHub Actions workflow run summary.",
    inputSchema: GITHUB_ACTIONS_RUN_GET_TOOL_INPUT_SCHEMA,
    permission: REMOTE_READ_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github", action: "actions_run_get" },
  }),
  createRoutedToolDefinition({
    id: "github_actions_job_logs_get",
    title: "Get Actions Job Logs",
    description: "Get the latest log tail for a GitHub Actions workflow job.",
    inputSchema: GITHUB_ACTIONS_JOB_LOGS_GET_TOOL_INPUT_SCHEMA,
    permission: REMOTE_READ_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github", action: "actions_job_logs_get" },
  }),
  createRoutedToolDefinition({
    id: "github_cli_pr_checks_get",
    title: "Get PR Checks With CLI",
    description: "Get GitHub check runs through the bounded GitHub CLI lane.",
    inputSchema: GITHUB_PR_GET_TOOL_INPUT_SCHEMA,
    permission: REMOTE_READ_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github_cli", action: "pr_checks_get" },
  }),
  createRoutedToolDefinition({
    id: "github_cli_actions_run_get",
    title: "Get Actions Run With CLI",
    description: "Get GitHub Actions workflow run metadata through GitHub CLI.",
    inputSchema: GITHUB_ACTIONS_RUN_GET_TOOL_INPUT_SCHEMA,
    permission: REMOTE_READ_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github_cli", action: "actions_run_get" },
  }),
  createRoutedToolDefinition({
    id: "github_cli_actions_job_logs_get",
    title: "Get Actions Logs With CLI",
    description: "Get GitHub Actions workflow job logs through GitHub CLI.",
    inputSchema: GITHUB_ACTIONS_JOB_LOGS_GET_TOOL_INPUT_SCHEMA,
    permission: REMOTE_READ_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github_cli", action: "actions_job_logs_get" },
  }),
  createRoutedToolDefinition({
    id: "github_cli_pr_comment",
    title: "Comment On Pull Request",
    description: "Create a pull request comment through the GitHub CLI lane.",
    inputSchema: GITHUB_CLI_PR_COMMENT_TOOL_INPUT_SCHEMA,
    permission: REPOSITORY_APPROVAL_PERMISSION,
    sandboxClass: "network",
    tokenPolicy: REMOTE_TOKEN_POLICY,
    outputRenderer: "github",
    route: { plugin: "github_cli", action: "pr_comment" },
  }),
  createRoutedToolDefinition({
    id: "glob",
    title: "Glob Files",
    description: "Find workspace files by glob pattern.",
    inputSchema: GLOB_TOOL_INPUT_SCHEMA,
    permission: WORKSPACE_READ_PERMISSION,
    sandboxClass: "read",
    tokenPolicy: READ_TOKEN_POLICY,
    outputRenderer: "json",
    route: { plugin: "filesystem", action: "glob" },
  }),
  createRoutedToolDefinition({
    id: "grep",
    title: "Grep Files",
    description: "Search workspace file content by regular expression.",
    inputSchema: GREP_TOOL_INPUT_SCHEMA,
    permission: WORKSPACE_READ_PERMISSION,
    sandboxClass: "read",
    tokenPolicy: READ_TOKEN_POLICY,
    outputRenderer: "json",
    route: { plugin: "filesystem", action: "grep" },
  }),
];

const TOOL_DEFINITION_MAP = new Map(
  CODING_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]),
);

export function getCodingToolDefinition(id: string): ToolDefinition | null {
  return TOOL_DEFINITION_MAP.get(id as CodingToolId) ?? null;
}

export function getCodingToolDefinitions(): ToolDefinition[] {
  return [...CODING_TOOL_DEFINITIONS];
}

export function getCodingCoreToolRegistry(): Record<string, CoreTool> {
  const registry: Record<string, CoreTool> = {};
  for (const tool of CODING_TOOL_DEFINITIONS) {
    registry[tool.id] = {
      description: tool.description,
      parameters: tool.inputSchema,
    } as CoreTool;
  }
  return registry;
}

export function isCodingToolId(value: string): value is CodingToolId {
  return CODING_TOOL_IDS.includes(value as CodingToolId);
}
