import type { Sandbox } from "@cloudflare/sandbox";
import { z } from "zod";
import type { IPlugin, LogCallback, PluginExecutionContext, PluginResult } from "../interfaces/types";
import { GitHubCliTools } from "../schemas/github-cli";
import { normalizeRunId } from "./security/PathGuard";
import { resolveScopedWorkspaceRoot } from "./security/WorkspaceScope";
import { runSafeCommand } from "./security/SafeCommand";
import {
  readToolboxCommandContext,
  withToolboxCommandContext,
} from "./security/ToolboxCommandContext";

const SAFE_SEGMENT_REGEX = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_SHA_REGEX = /^[A-Fa-f0-9]{7,64}$/;
const MAX_ACTIONS_LOG_TAIL_LINES = 2_000;
const DEFAULT_ACTIONS_LOG_TAIL_LINES = 300;
const MAX_ACTIONS_LOG_PAYLOAD_CHARS = 200_000;
const MAX_GH_JSON_PAYLOAD_CHARS = 500_000;
const MAX_PR_COMMENT_BODY_CHARS = 20_000;

const GitHubCliPayloadSchema = z.object({
  action: z.enum([
    "pr_checks_get",
    "actions_run_get",
    "actions_job_logs_get",
    "pr_comment",
  ]),
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  number: z.number().int().positive().optional(),
  actionsRunId: z.number().int().positive().optional(),
  actionsJobId: z.number().int().positive().optional(),
  tailLines: z.number().int().min(1).max(MAX_ACTIONS_LOG_TAIL_LINES).optional(),
  body: z.string().min(1).max(MAX_PR_COMMENT_BODY_CHARS).optional(),
  token: z.string().min(1).max(400).optional(),
  ghCliLaneEnabled: z.boolean().optional(),
  ghCliCiEnabled: z.boolean().optional(),
  ghCliPrCommentEnabled: z.boolean().optional(),
  runId: z.string().optional(),
});

type GitHubCliPayload = z.infer<typeof GitHubCliPayloadSchema>;

interface GhCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface GitHubCliFeatureFlags {
  laneEnabled: boolean;
  ciEnabled: boolean;
  prCommentEnabled: boolean;
}

interface GitHubCliExecutionContext {
  runId: string;
  workspaceRoot: string;
  toolboxContext: ReturnType<typeof readToolboxCommandContext>;
}

export class GitHubCliPlugin implements IPlugin {
  name = "github_cli";
  tools = GitHubCliTools;

  async execute(
    sandbox: Sandbox,
    payload: unknown,
    _onLog?: LogCallback,
    context?: PluginExecutionContext,
  ): Promise<PluginResult> {
    try {
      const toolboxContext = readToolboxCommandContext(payload);
      const parsed = GitHubCliPayloadSchema.parse(payload);
      validateRepositorySegments(parsed.owner, parsed.repo);
      const featureFlags = resolveGitHubCliFeatureFlags(parsed);
      assertEnabledGitHubCliAction(parsed.action, featureFlags);
      const token = validateCliToken(parsed.token);
      const runId = normalizeRunId(parsed.runId ?? toolboxContext.runId);
      const execution: GitHubCliExecutionContext = {
        runId,
        workspaceRoot: resolveScopedWorkspaceRoot(context, runId),
        toolboxContext,
      };
      await this.ensureWorkspace(sandbox, execution);

      switch (parsed.action) {
        case "pr_checks_get":
          return await this.getPullRequestChecks(
            sandbox,
            parsed,
            token,
            execution,
          );
        case "actions_run_get":
          return await this.getActionsRun(
            sandbox,
            parsed,
            token,
            execution,
          );
        case "actions_job_logs_get":
          return await this.getActionsJobLogs(
            sandbox,
            parsed,
            token,
            execution,
          );
        case "pr_comment":
          return await this.createPullRequestComment(
            sandbox,
            parsed,
            token,
            execution,
          );
        default:
          return { success: false, error: "Unsupported github_cli action" };
      }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "GitHub CLI request failed.",
      };
    }
  }

  private async ensureWorkspace(
    sandbox: Sandbox,
    execution: GitHubCliExecutionContext,
  ): Promise<void> {
    const result = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        {
          command: "mkdir",
          args: ["-p", execution.workspaceRoot],
          runId: execution.runId,
        },
        execution.toolboxContext,
        "github_cli.prepare_workspace",
      ),
      ["mkdir"],
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Failed to prepare workspace for github_cli.");
    }
  }

  private async getPullRequestChecks(
    sandbox: Sandbox,
    payload: GitHubCliPayload,
    token: string,
    execution: GitHubCliExecutionContext,
  ): Promise<PluginResult> {
    const number = requirePositiveInteger(payload.number, "Pull request number");
    const prEndpoint = `/repos/${payload.owner}/${payload.repo}/pulls/${number}`;
    const pr = await this.requestGhJson<Record<string, unknown>>(
      sandbox,
      {
        endpoint: prEndpoint,
        token,
        ...execution,
        toolName: "github_cli.pr_checks_get.pull",
      },
    );
    if ("error" in pr) {
      return pr.error;
    }

    const headSha = readString(
      (toRecord(pr.value.head) ?? {}).sha,
    );
    if (!headSha || !SAFE_SHA_REGEX.test(headSha)) {
      return {
        success: false,
        error: "Pull request head SHA is missing from GitHub CLI response.",
      };
    }

    const checksEndpoint = `/repos/${payload.owner}/${payload.repo}/commits/${headSha}/check-runs`;
    const checks = await this.requestGhJson<{
      total_count?: unknown;
      check_runs?: unknown;
    }>(sandbox, {
      endpoint: checksEndpoint,
      token,
      ...execution,
      toolName: "github_cli.pr_checks_get.check_runs",
    });
    if ("error" in checks) {
      return checks.error;
    }

    const checkRuns = Array.isArray(checks.value.check_runs)
      ? checks.value.check_runs
          .map((entry) => toRecord(entry))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .map((entry) => ({
            id: readNumber(entry.id),
            name: readString(entry.name),
            status: readString(entry.status),
            conclusion: readString(entry.conclusion),
            detailsUrl: readString(entry.details_url),
            startedAt: readString(entry.started_at),
            completedAt: readString(entry.completed_at),
          }))
      : [];

    return {
      success: true,
      output: JSON.stringify({
        pullRequestNumber: number,
        headSha,
        totalCount:
          typeof checks.value.total_count === "number"
            ? checks.value.total_count
            : checkRuns.length,
        checkRuns,
      }),
    };
  }

  private async getActionsRun(
    sandbox: Sandbox,
    payload: GitHubCliPayload,
    token: string,
    execution: GitHubCliExecutionContext,
  ): Promise<PluginResult> {
    const actionsRunId = requirePositiveInteger(
      payload.actionsRunId,
      "Actions run id",
    );
    const endpoint = `/repos/${payload.owner}/${payload.repo}/actions/runs/${actionsRunId}`;
    const run = await this.requestGhJson<Record<string, unknown>>(sandbox, {
      endpoint,
      token,
      ...execution,
      toolName: "github_cli.actions_run_get",
    });
    if ("error" in run) {
      return run.error;
    }

    return {
      success: true,
      output: JSON.stringify({
        id: readNumber(run.value.id),
        name: readString(run.value.name),
        status: readString(run.value.status),
        conclusion: readString(run.value.conclusion),
        event: readString(run.value.event),
        htmlUrl: readString(run.value.html_url),
        headBranch: readString(run.value.head_branch),
        headSha: readString(run.value.head_sha),
        runNumber: readNumber(run.value.run_number),
        createdAt: readString(run.value.created_at),
        updatedAt: readString(run.value.updated_at),
      }),
    };
  }

  private async getActionsJobLogs(
    sandbox: Sandbox,
    payload: GitHubCliPayload,
    token: string,
    execution: GitHubCliExecutionContext,
  ): Promise<PluginResult> {
    const actionsJobId = requirePositiveInteger(payload.actionsJobId, "Actions job id");
    const tailLines = normalizeActionsTailLineLimit(payload.tailLines);
    const endpoint = `/repos/${payload.owner}/${payload.repo}/actions/jobs/${actionsJobId}/logs`;

    const logsResult = await this.requestGhText(sandbox, {
      endpoint,
      token,
      ...execution,
      toolName: "github_cli.actions_job_logs_get",
    });
    if ("error" in logsResult) {
      return logsResult.error;
    }

    const normalizedLogs = logsResult.value.replace(/\r\n/g, "\n");
    const boundedLogs =
      normalizedLogs.length > MAX_ACTIONS_LOG_PAYLOAD_CHARS
        ? normalizedLogs.slice(-MAX_ACTIONS_LOG_PAYLOAD_CHARS)
        : normalizedLogs;
    const lines = boundedLogs.length === 0 ? [] : boundedLogs.split("\n");
    const tail = lines.slice(-tailLines).join("\n");

    return {
      success: true,
      output: JSON.stringify({
        actionsJobId,
        tailLines,
        totalLines: lines.length,
        truncated: lines.length > tailLines,
        logsTail: tail,
        sourceTruncated: boundedLogs.length !== normalizedLogs.length,
      }),
    };
  }

  private async createPullRequestComment(
    sandbox: Sandbox,
    payload: GitHubCliPayload,
    token: string,
    execution: GitHubCliExecutionContext,
  ): Promise<PluginResult> {
    const number = requirePositiveInteger(payload.number, "Pull request number");
    const body = requireCommentBody(payload.body);
    const endpoint = `/repos/${payload.owner}/${payload.repo}/issues/${number}/comments`;
    const comment = await this.requestGhJson<Record<string, unknown>>(sandbox, {
      endpoint,
      token,
      ...execution,
      toolName: "github_cli.pr_comment",
      method: "POST",
      fields: {
        body,
      },
    });
    if ("error" in comment) {
      return comment.error;
    }

    return {
      success: true,
      output: JSON.stringify({
        pullRequestNumber: number,
        commentId: readNumber(comment.value.id),
        body: readString(comment.value.body),
        htmlUrl: readString(comment.value.html_url),
        createdAt: readString(comment.value.created_at),
        updatedAt: readString(comment.value.updated_at),
        author: readString((toRecord(comment.value.user) ?? {}).login),
      }),
    };
  }

  private async requestGhJson<T>(
    sandbox: Sandbox,
    input: {
      endpoint: string;
      token: string;
      runId: string;
      workspaceRoot: string;
      toolboxContext: ReturnType<typeof readToolboxCommandContext>;
      toolName: string;
      method?: "GET" | "POST";
      fields?: Record<string, string>;
    },
  ): Promise<{ value: T } | { error: PluginResult }> {
    const commandResult = await this.runGhApiCommand(sandbox, {
      ...input,
      acceptHeader: "application/vnd.github+json",
    });
    if (commandResult.exitCode !== 0) {
      return {
        error: {
          success: false,
          error: normalizeGhFailureMessage(commandResult.stderr, commandResult.stdout),
        },
      };
    }

    if (commandResult.stdout.length > MAX_GH_JSON_PAYLOAD_CHARS) {
      return {
        error: {
          success: false,
          error:
            "GitHub CLI response exceeded the allowed size for JSON normalization.",
        },
      };
    }

    try {
      return {
        value: JSON.parse(commandResult.stdout) as T,
      };
    } catch (error) {
      return {
        error: {
          success: false,
          error: `GitHub CLI returned invalid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
  }

  private async requestGhText(
    sandbox: Sandbox,
    input: {
      endpoint: string;
      token: string;
      runId: string;
      workspaceRoot: string;
      toolboxContext: ReturnType<typeof readToolboxCommandContext>;
      toolName: string;
      method?: "GET" | "POST";
      fields?: Record<string, string>;
    },
  ): Promise<{ value: string } | { error: PluginResult }> {
    const commandResult = await this.runGhApiCommand(sandbox, input);
    if (commandResult.exitCode !== 0) {
      return {
        error: {
          success: false,
          error: normalizeGhFailureMessage(commandResult.stderr, commandResult.stdout),
        },
      };
    }

    return { value: commandResult.stdout };
  }

  private async runGhApiCommand(
    sandbox: Sandbox,
    input: {
      endpoint: string;
      token: string;
      runId: string;
      workspaceRoot: string;
      toolboxContext: ReturnType<typeof readToolboxCommandContext>;
      toolName: string;
      method?: "GET" | "POST";
      fields?: Record<string, string>;
      acceptHeader?: string;
    },
  ): Promise<GhCommandResult> {
    const method = input.method ?? "GET";
    assertAllowedGhApiEndpoint({
      endpoint: input.endpoint,
      method,
    });
    const ghApiArgs = [
      "api",
      "--method",
      method,
      ...(input.acceptHeader
        ? ["--header", `Accept: ${input.acceptHeader}`]
        : []),
      ...formatGhApiFields(input.fields),
      input.endpoint,
    ];

    const result = await runSafeCommand(
      sandbox,
      withToolboxCommandContext(
        {
          command: "gh",
          args: ghApiArgs,
          env: {
            GH_TOKEN: input.token,
            GH_PROMPT_DISABLED: "1",
            GH_NO_UPDATE_NOTIFIER: "1",
          },
          cwd: input.workspaceRoot,
          runId: input.runId,
        },
        input.toolboxContext,
        input.toolName,
      ),
      ["gh"],
    );

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

function validateRepositorySegments(owner: string, repo: string): void {
  if (!SAFE_SEGMENT_REGEX.test(owner)) {
    throw new Error("GitHub owner contains unsupported characters.");
  }
  if (!SAFE_SEGMENT_REGEX.test(repo)) {
    throw new Error("GitHub repo contains unsupported characters.");
  }
}

function validateCliToken(token: string | undefined): string {
  const normalized = token?.trim();
  if (!normalized) {
    throw new Error("GitHub token is required for github_cli actions.");
  }
  if (/[\0\r\n]/.test(normalized)) {
    throw new Error("GitHub token contains unsupported characters.");
  }
  return normalized;
}

function resolveGitHubCliFeatureFlags(
  payload: GitHubCliPayload,
): GitHubCliFeatureFlags {
  const laneEnabled = payload.ghCliLaneEnabled !== false;
  const ciEnabled = payload.ghCliCiEnabled !== false;
  const prCommentEnabled = payload.ghCliPrCommentEnabled === true;
  return {
    laneEnabled,
    ciEnabled,
    prCommentEnabled,
  };
}

function assertEnabledGitHubCliAction(
  action: GitHubCliPayload["action"],
  flags: GitHubCliFeatureFlags,
): void {
  if (!flags.laneEnabled) {
    throw new Error(
      "GitHub CLI lane is disabled by feature flag GH_CLI_LANE_ENABLED.",
    );
  }

  if (
    (action === "pr_checks_get" ||
      action === "actions_run_get" ||
      action === "actions_job_logs_get") &&
    !flags.ciEnabled
  ) {
    throw new Error(
      "GitHub CLI CI lane is disabled by feature flag GH_CLI_CI_ENABLED.",
    );
  }

  if (action === "pr_comment" && !flags.prCommentEnabled) {
    throw new Error(
      "GitHub CLI PR comment mutation is disabled by feature flag GH_CLI_PR_COMMENT_ENABLED.",
    );
  }
}

function requirePositiveInteger(value: number | undefined, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function requireCommentBody(body: string | undefined): string {
  const normalized = body?.trim();
  if (!normalized) {
    throw new Error("Pull request comment body is required.");
  }
  return normalized;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeActionsTailLineLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    return DEFAULT_ACTIONS_LOG_TAIL_LINES;
  }

  return Math.min(value, MAX_ACTIONS_LOG_TAIL_LINES);
}

function normalizeGhFailureMessage(stderr: string, stdout: string): string {
  const combined = `${stderr}\n${stdout}`.trim();
  if (/not found|No such file or directory|unknown command/i.test(combined)) {
    return "GitHub CLI is not available in this runtime image.";
  }

  if (/HTTP 401/i.test(combined)) {
    return "GitHub CLI authentication failed (401). Reconnect GitHub and retry.";
  }

  if (/HTTP 403/i.test(combined)) {
    return "GitHub CLI request was forbidden (403) due to insufficient token scope or permissions. Reconnect GitHub with required scopes and retry.";
  }

  if (/resource not accessible by integration|insufficient_scopes/i.test(combined)) {
    return "GitHub CLI request failed due to insufficient token scope. Reconnect GitHub with required scopes and retry.";
  }

  if (combined.length > 0) {
    return combined;
  }

  return "GitHub CLI command failed.";
}

function assertAllowedGhApiEndpoint(input: {
  endpoint: string;
  method: "GET" | "POST";
}): void {
  const allowedPatternsByMethod: Record<
    "GET" | "POST",
    ReadonlyArray<RegExp>
  > = {
    GET: [
      /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pulls\/\d+$/,
      /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/commits\/[A-Fa-f0-9]{7,64}\/check-runs$/,
      /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\/\d+$/,
      /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/jobs\/\d+\/logs$/,
    ],
    POST: [
      /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues\/\d+\/comments$/,
    ],
  };

  const allowedPatterns = allowedPatternsByMethod[input.method];
  if (!allowedPatterns.some((pattern) => pattern.test(input.endpoint))) {
    throw new Error("GitHub CLI API endpoint is not allowed by policy.");
  }
}

function formatGhApiFields(
  fields: Record<string, string> | undefined,
): string[] {
  if (!fields) {
    return [];
  }

  const args: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!key.trim()) {
      continue;
    }
    args.push("--raw-field", `${key}=${value}`);
  }
  return args;
}
