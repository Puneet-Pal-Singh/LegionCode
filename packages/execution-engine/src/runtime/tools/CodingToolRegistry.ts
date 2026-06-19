import type { CoreTool } from "ai";
import { z } from "zod";

const PermissionRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
type PermissionRiskLevel = z.infer<typeof PermissionRiskLevelSchema>;

const PolicyDomainSchema = z.enum([
  "command",
  "path",
  "network",
  "git",
  "package_manager",
  "secret",
  "external_service",
  "tool",
]);
type PolicyDomain = z.infer<typeof PolicyDomainSchema>;

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

export const ToolBackendCapabilitySchema = z.enum([
  "filesystem_read",
  "filesystem_write",
  "shell",
  "git",
  "network",
  "github",
  "github_cli",
  "approval",
]);
export type ToolBackendCapability = z.infer<typeof ToolBackendCapabilitySchema>;

export const ToolParallelismSchema = z.enum([
  "parallel_safe",
  "exclusive_workspace_write",
  "exclusive_git_mutation",
  "serial_remote_mutation",
]);
export type ToolParallelism = z.infer<typeof ToolParallelismSchema>;

export const ToolRendererHintSchema = z.enum([
  "text",
  "json",
  "diff",
  "shell",
  "git",
  "github",
]);
export type ToolRendererHint = z.infer<typeof ToolRendererHintSchema>;

export const ToolPermissionMetadataSchema = z
  .object({
    domain: PolicyDomainSchema,
    subject: z.string().min(1),
    action: z.string().min(1).optional(),
    riskLevel: PermissionRiskLevelSchema,
  })
  .strict();
export interface ToolPermissionMetadata extends z.infer<
  typeof ToolPermissionMetadataSchema
> {}

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
  permissionMetadata: ToolPermissionMetadata;
  sandboxClass: ToolSandboxClass;
  requiredBackendCapabilities: readonly ToolBackendCapability[];
  riskLevel: PermissionRiskLevel;
  parallelism: ToolParallelism;
  tokenPolicy: ToolTokenPolicy;
  outputRenderer: ToolRendererHint;
  rendererHint: ToolRendererHint;
  preferredFor: readonly string[];
  avoidWhen?: readonly string[];
  alternatives?: readonly string[];
  route: ToolGatewayRoute;
  execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export const ToolDefinitionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    permissionMetadata: ToolPermissionMetadataSchema,
    sandboxClass: z.enum([
      "read",
      "write",
      "shell",
      "network",
      "git",
      "approval",
    ]),
    requiredBackendCapabilities: z.array(ToolBackendCapabilitySchema).min(1),
    riskLevel: PermissionRiskLevelSchema,
    parallelism: ToolParallelismSchema,
    rendererHint: ToolRendererHintSchema,
    preferredFor: z.array(z.string().min(1)).min(1),
    avoidWhen: z.array(z.string().min(1)).optional(),
    alternatives: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

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

function clampReadLimit(value: unknown): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value;
  }
  return Math.min(value, MAX_TOOL_READ_LINES);
}

export const READ_FILE_TOOL_INPUT_SCHEMA = createToolInputSchema({
  path: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  offset: z.number().int().min(0).optional(),
  limit: z.preprocess(
    clampReadLimit,
    z.number().int().min(1).max(MAX_TOOL_READ_LINES).optional(),
  ),
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
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});

export const EDIT_FILE_TOOL_INPUT_SCHEMA = createToolInputSchema({
  path: z.string().min(1).max(MAX_TOOL_PATH_LENGTH),
  oldText: z.string().min(1).max(MAX_TOOL_WRITE_CONTENT_LENGTH),
  newText: z.string().max(MAX_TOOL_WRITE_CONTENT_LENGTH),
  replaceAll: z.boolean().optional(),
  expectedReplacements: z.number().int().min(1).max(10_000).optional(),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});

export const MULTI_EDIT_TOOL_INPUT_SCHEMA = createToolInputSchema({
  edits: z.array(EDIT_FILE_TOOL_INPUT_SCHEMA).min(1).max(20),
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

export const GIT_BRANCH_SWITCH_TOOL_INPUT_SCHEMA =
  GIT_BRANCH_CREATE_TOOL_INPUT_SCHEMA;

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

export const GITHUB_ACTIONS_JOB_LOGS_GET_TOOL_INPUT_SCHEMA =
  createToolInputSchema({
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
  "edit_file",
  "multi_edit",
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
  requiredBackendCapabilities?: readonly ToolBackendCapability[];
  riskLevel?: PermissionRiskLevel;
  parallelism?: ToolParallelism;
  tokenPolicy: ToolTokenPolicy;
  outputRenderer?: ToolRendererHint;
  rendererHint?: ToolRendererHint;
  preferredFor?: readonly string[];
  avoidWhen?: readonly string[];
  alternatives?: readonly string[];
  route: Omit<ToolGatewayRoute, "toolName">;
}): ToolDefinition {
  const route = { toolName: input.id, ...input.route };
  const usage = describeToolUsage(input);
  const riskLevel = input.riskLevel ?? deriveRiskLevel(input.permission);
  const rendererHint = input.rendererHint ?? input.outputRenderer;
  if (!rendererHint) {
    throw new Error(`Tool "${input.id}" must define a renderer hint.`);
  }
  const definition = {
    ...input,
    permissionMetadata: buildPermissionMetadata({ ...input, riskLevel }),
    requiredBackendCapabilities:
      input.requiredBackendCapabilities ?? deriveBackendCapabilities(input),
    riskLevel,
    parallelism: input.parallelism ?? deriveParallelism(input),
    outputRenderer: rendererHint,
    rendererHint,
    preferredFor: input.preferredFor ?? usage.preferredFor,
    avoidWhen: input.avoidWhen ?? usage.avoidWhen,
    alternatives: input.alternatives ?? usage.alternatives,
    route,
    async execute(
      toolInput: Record<string, unknown>,
      context: ToolExecutionContext,
    ) {
      const result = await context.execute(
        route.plugin,
        route.action,
        toolInput,
      );
      return adaptPluginResult(input.title, result);
    },
  };
  ToolDefinitionSchema.parse(definition);
  return definition;
}

function buildPermissionMetadata(input: {
  id: CodingToolId;
  route: Omit<ToolGatewayRoute, "toolName">;
  sandboxClass: ToolSandboxClass;
  riskLevel: PermissionRiskLevel;
}): ToolPermissionMetadata {
  return ToolPermissionMetadataSchema.parse({
    domain: resolvePolicyDomain(input),
    subject: input.id,
    action: input.route.action,
    riskLevel: input.riskLevel,
  });
}

function deriveRiskLevel(
  permission: ToolPermissionPolicy,
): PermissionRiskLevel {
  if (permission.mode === "deny") {
    return "critical";
  }
  if (permission.mode === "approval_required") {
    return "high";
  }
  return "low";
}

function deriveBackendCapabilities(input: {
  route: Omit<ToolGatewayRoute, "toolName">;
  permission: ToolPermissionPolicy;
  sandboxClass: ToolSandboxClass;
}): ToolBackendCapability[] {
  const capabilities = new Set<ToolBackendCapability>();
  if (input.sandboxClass === "read") {
    capabilities.add("filesystem_read");
  }
  if (input.sandboxClass === "write") {
    capabilities.add("filesystem_write").add("approval");
  }
  if (input.sandboxClass === "shell") {
    capabilities.add("shell").add("approval");
  }
  if (input.sandboxClass === "git") {
    capabilities.add("git");
  }
  if (input.sandboxClass === "network") {
    capabilities.add("network");
  }
  if (input.route.plugin === "github") {
    capabilities.add("github");
  }
  if (input.route.plugin === "github_cli") {
    capabilities.add("github_cli");
  }
  if (input.permission.mode === "approval_required") {
    capabilities.add("approval");
  }
  return Array.from(capabilities);
}

function deriveParallelism(input: {
  permission: ToolPermissionPolicy;
  sandboxClass: ToolSandboxClass;
  route: Omit<ToolGatewayRoute, "toolName">;
}): ToolParallelism {
  if (input.sandboxClass === "write" || input.sandboxClass === "shell") {
    return "exclusive_workspace_write";
  }
  if (
    input.sandboxClass === "git" &&
    input.permission.mode === "approval_required"
  ) {
    return "exclusive_git_mutation";
  }
  if (
    input.sandboxClass === "network" &&
    input.permission.mode === "approval_required"
  ) {
    return "serial_remote_mutation";
  }
  return "parallel_safe";
}

function describeToolUsage(input: {
  id: CodingToolId;
  sandboxClass: ToolSandboxClass;
}): {
  preferredFor: string[];
  avoidWhen?: string[];
  alternatives?: string[];
} {
  if (input.id === "read_file") {
    return {
      preferredFor: ["file inspection", "line range reads"],
      alternatives: ["bash"],
    };
  }
  if (input.id === "glob" || input.id === "list_files") {
    return {
      preferredFor: ["file discovery", "directory inspection"],
      alternatives: ["grep", "bash"],
    };
  }
  if (input.id === "grep") {
    return {
      preferredFor: ["content search", "symbol or text discovery"],
      alternatives: ["read_file", "bash"],
    };
  }
  return describeNonReadToolUsage(input);
}

function describeNonReadToolUsage(input: { sandboxClass: ToolSandboxClass }): {
  preferredFor: string[];
  avoidWhen?: string[];
  alternatives?: string[];
} {
  if (input.sandboxClass === "shell") {
    return {
      preferredFor: ["tests", "builds", "package scripts"],
      avoidWhen: ["simple file inspection", "git status or diff"],
      alternatives: ["read_file", "list_files", "glob", "grep", "git_status"],
    };
  }
  if (input.sandboxClass === "git") {
    return {
      preferredFor: ["repository status", "diffs", "branch and PR workflow"],
      alternatives: ["bash"],
    };
  }
  if (input.sandboxClass === "network") {
    return {
      preferredFor: ["remote GitHub metadata", "CI checks", "review threads"],
      alternatives: ["bash"],
    };
  }
  return {
    preferredFor: ["workspace mutation"],
    alternatives: ["bash"],
  };
}

function resolvePolicyDomain(input: {
  route: Omit<ToolGatewayRoute, "toolName">;
  sandboxClass: ToolSandboxClass;
}): PolicyDomain {
  if (input.sandboxClass === "shell") {
    return "command";
  }
  if (input.sandboxClass === "git") {
    return "git";
  }
  if (input.sandboxClass === "network") {
    return input.route.plugin === "github_cli" ? "external_service" : "network";
  }
  return "tool";
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
  const metadata =
    isRecord(result) && isRecord(result.metadata) ? result.metadata : {};
  return {
    title,
    output: readString(output) ?? stringifyOutput(output),
    metadata,
    truncated:
      readBoolean(isRecord(result) ? result.truncated : undefined) ?? false,
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
    id: "edit_file",
    title: "Edit File",
    description: "Atomically replace exact text in a workspace file.",
    inputSchema: EDIT_FILE_TOOL_INPUT_SCHEMA,
    permission: WORKSPACE_WRITE_PERMISSION,
    sandboxClass: "write",
    tokenPolicy: WRITE_TOKEN_POLICY,
    outputRenderer: "text",
    preferredFor: ["small exact replacements", "hash-guarded edits"],
    alternatives: ["write_file", "multi_edit"],
    route: { plugin: "filesystem", action: "edit_file" },
  }),
  createRoutedToolDefinition({
    id: "multi_edit",
    title: "Multi Edit",
    description:
      "Apply validated exact-text edits across unique workspace files.",
    inputSchema: MULTI_EDIT_TOOL_INPUT_SCHEMA,
    permission: WORKSPACE_WRITE_PERMISSION,
    sandboxClass: "write",
    tokenPolicy: WRITE_TOKEN_POLICY,
    outputRenderer: "json",
    preferredFor: ["coordinated exact replacements across files"],
    alternatives: ["edit_file"],
    route: { plugin: "filesystem", action: "multi_edit" },
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

export class CodingToolRegistry {
  private readonly definitionsById: ReadonlyMap<string, ToolDefinition>;

  constructor(definitions: readonly ToolDefinition[]) {
    const parsedDefinitions = definitions.map((definition) => {
      ToolDefinitionSchema.parse(definition);
      return definition;
    });
    this.definitionsById = createUniqueDefinitionMap(parsedDefinitions);
  }

  listDefinitions(): ToolDefinition[] {
    return Array.from(this.definitionsById.values());
  }

  getDefinition(id: string): ToolDefinition | null {
    return this.definitionsById.get(id) ?? null;
  }

  hasDefinition(id: string): boolean {
    return this.definitionsById.has(id);
  }

  toCoreToolRegistry(): Record<string, CoreTool> {
    const registry: Record<string, CoreTool> = {};
    for (const tool of this.definitionsById.values()) {
      registry[tool.id] = {
        description: tool.description,
        parameters: tool.inputSchema,
      } as CoreTool;
    }
    return registry;
  }
}

export const codingToolRegistry = new CodingToolRegistry(
  CODING_TOOL_DEFINITIONS,
);

export function getCodingToolDefinition(id: string): ToolDefinition | null {
  return codingToolRegistry.getDefinition(id);
}

export function getCodingToolDefinitions(): ToolDefinition[] {
  return codingToolRegistry.listDefinitions();
}

export function getCodingCoreToolRegistry(): Record<string, CoreTool> {
  return codingToolRegistry.toCoreToolRegistry();
}

export function isCodingToolId(value: string): value is CodingToolId {
  return CODING_TOOL_IDS.includes(value as CodingToolId);
}

function createUniqueDefinitionMap(
  definitions: readonly ToolDefinition[],
): ReadonlyMap<string, ToolDefinition> {
  const definitionsById = new Map<string, ToolDefinition>();
  for (const definition of definitions) {
    if (definitionsById.has(definition.id)) {
      throw new Error(`Duplicate tool registration: "${definition.id}".`);
    }
    definitionsById.set(definition.id, definition);
  }
  return definitionsById;
}
