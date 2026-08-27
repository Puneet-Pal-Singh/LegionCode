import { z } from "zod";
import type { Sandbox } from "@cloudflare/sandbox";
import type { IPlugin, LogCallback, PluginResult } from "../interfaces/types";
import { GitHubTools } from "../schemas/github";

const SAFE_SEGMENT_REGEX = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const REVIEW_COMMENTS_PAGE_SIZE = 100;
const REVIEW_COMMENTS_MAX_PAGES = 20;
const DEFAULT_ACTIONS_LOG_TAIL_LINES = 300;
const MAX_ACTIONS_LOG_TAIL_LINES = 2_000;

const GitHubPayloadSchema = z.object({
  action: z.enum([
    "pr_list",
    "pr_get",
    "pr_checks_get",
    "review_threads_get",
    "issue_get",
    "actions_run_get",
    "actions_job_logs_get",
  ]),
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  state: z.enum(["open", "closed", "all"]).optional(),
  head: z.string().min(1).max(200).optional(),
  number: z.number().int().positive().optional(),
  actionsRunId: z.number().int().positive().optional(),
  actionsJobId: z.number().int().positive().optional(),
  tailLines: z.number().int().min(1).max(MAX_ACTIONS_LOG_TAIL_LINES).optional(),
  token: z.string().min(1).optional(),
});

type GitHubPayload = z.infer<typeof GitHubPayloadSchema>;

interface GitHubRequestInit {
  method?: "GET";
}

export class GitHubPlugin implements IPlugin {
  name = "github";
  tools = GitHubTools;

  async execute(
    _sandbox: Sandbox,
    payload: unknown,
    _onLog?: LogCallback,
  ): Promise<PluginResult> {
    try {
      const parsed = GitHubPayloadSchema.parse(payload);
      validateRepositorySegments(parsed.owner, parsed.repo);

      const token = parsed.token?.trim();
      if (!token) {
        return {
          success: false,
          error: "GitHub token is required for connector metadata actions.",
        };
      }

      switch (parsed.action) {
        case "pr_list":
          return await this.listPullRequests(parsed, token);
        case "pr_get":
          return await this.getPullRequest(parsed, token);
        case "pr_checks_get":
          return await this.getPullRequestChecks(parsed, token);
        case "review_threads_get":
          return await this.getReviewThreads(parsed, token);
        case "issue_get":
          return await this.getIssue(parsed, token);
        case "actions_run_get":
          return await this.getActionsRun(parsed, token);
        case "actions_job_logs_get":
          return await this.getActionsJobLogs(parsed, token);
        default:
          return { success: false, error: "Unsupported github action" };
      }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "GitHub connector request failed.",
      };
    }
  }

  private async listPullRequests(
    payload: GitHubPayload,
    token: string,
  ): Promise<PluginResult> {
    const query = new URLSearchParams();
    query.set("state", payload.state ?? "open");
    query.set("per_page", "100");
    if (payload.head) {
      query.set("head", `${payload.owner}:${payload.head}`);
    }

    const pullRequests = await this.requestGitHub<Array<Record<string, unknown>>>(
      token,
      `/repos/${payload.owner}/${payload.repo}/pulls?${query.toString()}`,
    );

    const items = pullRequests
      .map((pr) => ({
        number: readNumber(pr.number),
        title: readString(pr.title),
        state: readString(pr.state),
        draft: readBoolean(pr.draft),
        htmlUrl: readString(pr.html_url),
        headRef: readString((pr.head as Record<string, unknown> | undefined)?.ref),
        headSha: readString((pr.head as Record<string, unknown> | undefined)?.sha),
        baseRef: readString((pr.base as Record<string, unknown> | undefined)?.ref),
        author: readString((pr.user as Record<string, unknown> | undefined)?.login),
        createdAt: readString(pr.created_at),
        updatedAt: readString(pr.updated_at),
      }))
      .filter((item) => typeof item.number === "number");

    return {
      success: true,
      output: JSON.stringify({
        state: payload.state ?? "open",
        head: payload.head ?? null,
        count: items.length,
        pullRequests: items,
      }),
    };
  }

  private async getPullRequest(
    payload: GitHubPayload,
    token: string,
  ): Promise<PluginResult> {
    const number = requireNumber(payload.number, "Pull request number");
    const pr = await this.requestGitHub<Record<string, unknown>>(
      token,
      `/repos/${payload.owner}/${payload.repo}/pulls/${number}`,
    );

    return {
      success: true,
      output: JSON.stringify({
        number: readNumber(pr.number),
        title: readString(pr.title),
        state: readString(pr.state),
        draft: readBoolean(pr.draft),
        mergeable: readBoolean(pr.mergeable),
        htmlUrl: readString(pr.html_url),
        headRef: readString((pr.head as Record<string, unknown> | undefined)?.ref),
        headSha: readString((pr.head as Record<string, unknown> | undefined)?.sha),
        baseRef: readString((pr.base as Record<string, unknown> | undefined)?.ref),
        author: readString((pr.user as Record<string, unknown> | undefined)?.login),
        createdAt: readString(pr.created_at),
        updatedAt: readString(pr.updated_at),
      }),
    };
  }

  private async getPullRequestChecks(
    payload: GitHubPayload,
    token: string,
  ): Promise<PluginResult> {
    const number = requireNumber(payload.number, "Pull request number");
    const pr = await this.requestGitHub<Record<string, unknown>>(
      token,
      `/repos/${payload.owner}/${payload.repo}/pulls/${number}`,
    );
    const headSha = readString(
      (pr.head as Record<string, unknown> | undefined)?.sha,
    );
    if (!headSha) {
      return {
        success: false,
        error: "Pull request head SHA is missing from GitHub response.",
      };
    }

    const checks = await this.requestGitHub<{
      total_count?: unknown;
      check_runs?: unknown;
    }>(
      token,
      `/repos/${payload.owner}/${payload.repo}/commits/${headSha}/check-runs`,
    );

    const checkRuns = Array.isArray(checks.check_runs)
      ? checks.check_runs
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
          typeof checks.total_count === "number" ? checks.total_count : checkRuns.length,
        checkRuns,
      }),
    };
  }

  private async getReviewThreads(
    payload: GitHubPayload,
    token: string,
  ): Promise<PluginResult> {
    const number = requireNumber(payload.number, "Pull request number");
    const { comments, truncated } = await this.fetchReviewComments(
      payload.owner,
      payload.repo,
      number,
      token,
    );

    const commentMap = new Map<number, Record<string, unknown>>();
    for (const comment of comments) {
      const id = readNumber(comment.id);
      if (typeof id === "number") {
        commentMap.set(id, comment);
      }
    }

    const grouped = new Map<
      number,
      {
        threadId: number;
        path?: string;
        line?: number;
        comments: Array<{
          id?: number;
          body?: string;
          author?: string;
          createdAt?: string;
        }>;
      }
    >();

    for (const comment of comments) {
      const id = readNumber(comment.id);
      if (typeof id !== "number") {
        continue;
      }
      const rootId = resolveRootReviewCommentId(commentMap, comment);
      const existing = grouped.get(rootId) ?? {
        threadId: rootId,
        path: readString(comment.path),
        line: readNumber(comment.line),
        comments: [],
      };
      existing.comments.push({
        id,
        body: readString(comment.body),
        author: readString((toRecord(comment.user) ?? {}).login),
        createdAt: readString(comment.created_at),
      });
      grouped.set(rootId, existing);
    }

    return {
      success: true,
      output: JSON.stringify({
        pullRequestNumber: number,
        threadCount: grouped.size,
        truncated,
        threads: Array.from(grouped.values()),
      }),
    };
  }

  private async getIssue(
    payload: GitHubPayload,
    token: string,
  ): Promise<PluginResult> {
    const number = requireNumber(payload.number, "Issue number");
    const issue = await this.requestGitHub<Record<string, unknown>>(
      token,
      `/repos/${payload.owner}/${payload.repo}/issues/${number}`,
    );

    return {
      success: true,
      output: JSON.stringify({
        number: readNumber(issue.number),
        title: readString(issue.title),
        state: readString(issue.state),
        htmlUrl: readString(issue.html_url),
        author: readString((toRecord(issue.user) ?? {}).login),
        labels: Array.isArray(issue.labels)
          ? issue.labels
              .map((entry) => readString((toRecord(entry) ?? {}).name))
              .filter((entry): entry is string => Boolean(entry))
          : [],
        isPullRequest: Boolean(toRecord(issue.pull_request)),
        createdAt: readString(issue.created_at),
        updatedAt: readString(issue.updated_at),
      }),
    };
  }

  private async getActionsRun(
    payload: GitHubPayload,
    token: string,
  ): Promise<PluginResult> {
    const actionsRunId = requireNumber(payload.actionsRunId, "Actions run id");
    const run = await this.requestGitHub<Record<string, unknown>>(
      token,
      `/repos/${payload.owner}/${payload.repo}/actions/runs/${actionsRunId}`,
    );

    return {
      success: true,
      output: JSON.stringify({
        id: readNumber(run.id),
        name: readString(run.name),
        status: readString(run.status),
        conclusion: readString(run.conclusion),
        event: readString(run.event),
        htmlUrl: readString(run.html_url),
        headBranch: readString(run.head_branch),
        headSha: readString(run.head_sha),
        runNumber: readNumber(run.run_number),
        createdAt: readString(run.created_at),
        updatedAt: readString(run.updated_at),
      }),
    };
  }

  private async getActionsJobLogs(
    payload: GitHubPayload,
    token: string,
  ): Promise<PluginResult> {
    const actionsJobId = requireNumber(payload.actionsJobId, "Actions job id");
    const tailLines = normalizeActionsTailLineLimit(payload.tailLines);
    let logs: string;
    try {
      logs = await this.requestGitHubText(
        token,
        `/repos/${payload.owner}/${payload.repo}/actions/jobs/${actionsJobId}/logs`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isGitHubActionsLogsAuthError(message)) {
        return {
          success: false,
          error:
            "GitHub Actions job logs require additional authorization (401/403). Reconnect GitHub with Actions read access and retry.",
        };
      }
      throw error;
    }
    const normalizedLogs = logs.replace(/\r\n/g, "\n");
    const lines = normalizedLogs.length === 0 ? [] : normalizedLogs.split("\n");
    const tail = lines.slice(-tailLines).join("\n");

    return {
      success: true,
      output: JSON.stringify({
        actionsJobId,
        tailLines,
        totalLines: lines.length,
        truncated: lines.length > tailLines,
        logsTail: tail,
      }),
    };
  }

  private async requestGitHub<T>(
    token: string,
    path: string,
    init: GitHubRequestInit = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, GITHUB_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method: init.method ?? "GET",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "LegionCode-GitHub-Connector/0.1.0",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(
          `GitHub API request timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim() || "GitHub API request failed.";
      throw new Error(`GitHub API error (${response.status}): ${detail}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(
        `GitHub API returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async requestGitHubText(
    token: string,
    path: string,
    init: GitHubRequestInit = {},
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, GITHUB_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method: init.method ?? "GET",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "LegionCode-GitHub-Connector/0.1.0",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(
          `GitHub API request timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim() || "GitHub API request failed.";
      throw new Error(`GitHub API error (${response.status}): ${detail}`);
    }

    return text;
  }

  private async fetchReviewComments(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<{ comments: Array<Record<string, unknown>>; truncated: boolean }> {
    const comments: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= REVIEW_COMMENTS_MAX_PAGES; page += 1) {
      const pageComments = await this.requestGitHub<Array<Record<string, unknown>>>(
        token,
        `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=${REVIEW_COMMENTS_PAGE_SIZE}&page=${page}`,
      );
      comments.push(...pageComments);
      if (pageComments.length < REVIEW_COMMENTS_PAGE_SIZE) {
        return { comments, truncated: false };
      }
    }

    return { comments, truncated: true };
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

function requireNumber(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
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

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function resolveRootReviewCommentId(
  commentMap: Map<number, Record<string, unknown>>,
  comment: Record<string, unknown>,
): number {
  const currentId = readNumber(comment.id);
  if (typeof currentId !== "number") {
    return -1;
  }

  let rootId = currentId;
  let parentId = readNumber(comment.in_reply_to_id);

  while (typeof parentId === "number") {
    const parent = commentMap.get(parentId);
    if (!parent) {
      rootId = parentId;
      break;
    }
    rootId = parentId;
    parentId = readNumber(parent.in_reply_to_id);
  }

  return rootId;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const maybeName = (error as { name?: unknown }).name;
  return typeof maybeName === "string" && maybeName === "AbortError";
}

function normalizeActionsTailLineLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ACTIONS_LOG_TAIL_LINES;
  }

  if (value < 1) {
    return DEFAULT_ACTIONS_LOG_TAIL_LINES;
  }

  return Math.min(Math.floor(value), MAX_ACTIONS_LOG_TAIL_LINES);
}

function isGitHubActionsLogsAuthError(message: string): boolean {
  return /GitHub API error \((401|403)\):/i.test(message);
}
