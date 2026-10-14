import { z } from "zod";
import type { Sandbox } from "@cloudflare/sandbox";
import type { IPlugin, LogCallback, PluginResult } from "../interfaces/types";
import { GitHubTools } from "../schemas/github";

const SAFE_SEGMENT_REGEX = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const REVIEW_COMMENTS_PAGE_SIZE = 100;
const REVIEW_COMMENTS_MAX_PAGES = 20;
const PULL_REQUEST_MAX_PAGES = 20;
const PULL_REQUEST_FILES_MAX_PAGES = 3;
const MAX_PR_FILES_OUTPUT_BYTES = 18_000;
const MAX_PR_FILE_PATCH_BYTES = 4_000;
const DEFAULT_ACTIONS_LOG_TAIL_LINES = 300;
const MAX_ACTIONS_LOG_TAIL_LINES = 2_000;

const GitHubPayloadSchema = z.object({
  action: z.enum([
    "pr_list",
    "pr_get",
    "pr_files_get",
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
  mergedLimit: z.number().int().min(1).max(20).optional(),
  page: z.number().int().min(1).max(PULL_REQUEST_MAX_PAGES).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  fileOffset: z.number().int().min(0).max(299).optional(),
  fileLimit: z.number().int().min(1).max(100).optional(),
  fileName: z.string().min(1).max(1_000).optional(),
  patchOffset: z.number().int().min(0).max(1_000_000).optional(),
  patchLimit: z.number().int().min(1).max(MAX_PR_FILE_PATCH_BYTES).optional(),
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
        case "pr_files_get":
          return await this.getPullRequestFiles(parsed, token);
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
    if (payload.mergedLimit) {
      if (payload.state !== undefined && payload.state !== "closed") {
        return {
          success: false,
          error:
            "mergedLimit selects closed pull requests; omit state or set it to closed.",
        };
      }
      if (payload.page !== undefined || payload.perPage !== undefined) {
        return {
          success: false,
          error: "mergedLimit cannot be combined with page or perPage.",
        };
      }
      return await this.listLatestMergedPullRequests(payload, token);
    }
    const perPage = payload.perPage ?? 100;
    const page = payload.page ?? 1;
    const query = new URLSearchParams({
      state: payload.state ?? "open",
      per_page: String(perPage),
    });
    if (payload.page !== undefined) query.set("page", String(page));
    if (payload.head) query.set("head", `${payload.owner}:${payload.head}`);
    const pullRequests = await this.requestGitHub<
      Array<Record<string, unknown>>
    >(
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
        headRef: readString(
          (pr.head as Record<string, unknown> | undefined)?.ref,
        ),
        headSha: readString(
          (pr.head as Record<string, unknown> | undefined)?.sha,
        ),
        headRepository: readString(
          (toRecord(toRecord(pr.head)?.repo) ?? {}).full_name,
        ),
        baseRef: readString(
          (pr.base as Record<string, unknown> | undefined)?.ref,
        ),
        baseRepository: readString(
          (toRecord(toRecord(pr.base)?.repo) ?? {}).full_name,
        ),
        author: readString(
          (pr.user as Record<string, unknown> | undefined)?.login,
        ),
        body: readString(pr.body),
        merged:
          readBoolean(pr.merged) ??
          (isValidGitHubTimestamp(pr.merged_at) ? true : null),
        mergedAt: readString(pr.merged_at),
        mergeCommitSha: readString(pr.merge_commit_sha),
        createdAt: readString(pr.created_at),
        updatedAt: readString(pr.updated_at),
      }))
      .filter((item) => typeof item.number === "number");

    return {
      success: true,
      output: JSON.stringify({
        state: payload.state ?? "open",
        head: payload.head ?? null,
        page,
        perPage,
        complete: pullRequests.length < perPage,
        nextPage: pullRequests.length < perPage ? null : page + 1,
        count: items.length,
        pullRequests: items,
      }),
    };
  }

  private async listLatestMergedPullRequests(
    payload: GitHubPayload,
    token: string,
  ): Promise<PluginResult> {
    const limit = requireNumber(
      payload.mergedLimit,
      "Merged pull request limit",
    );
    const found: Array<Record<string, unknown>> = [];
    let complete = false;
    let pagesFetched = 0;
    let stoppedAtMergeBound = false;
    let invalidMergeTimestampSeen = false;
    for (let page = 1; page <= PULL_REQUEST_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: "100",
        page: String(page),
      });
      if (payload.head) query.set("head", `${payload.owner}:${payload.head}`);
      const rows = await this.requestGitHub<Array<Record<string, unknown>>>(
        token,
        `/repos/${payload.owner}/${payload.repo}/pulls?${query.toString()}`,
      );
      pagesFetched = page;
      if (
        rows.some(
          (row) =>
            row.merged_at !== null &&
            row.merged_at !== undefined &&
            !isValidGitHubTimestamp(row.merged_at),
        )
      ) {
        invalidMergeTimestampSeen = true;
      }
      for (const row of rows) {
        if (isValidGitHubTimestamp(row.merged_at)) found.push(row);
      }
      const uniqueByNumber = new Map<number, Record<string, unknown>>();
      for (const row of found) {
        const number = readNumber(row.number);
        if (number !== undefined) uniqueByNumber.set(number, row);
      }
      found.splice(0, found.length, ...uniqueByNumber.values());
      found.sort(
        (left, right) =>
          timestampValue(right.merged_at) - timestampValue(left.merged_at),
      );
      if (found.length >= limit) {
        const cutoff = readString(found[limit - 1]?.merged_at);
        const oldestUpdated = readString(rows.at(-1)?.updated_at);
        if (
          isValidGitHubTimestamp(cutoff) &&
          isValidGitHubTimestamp(oldestUpdated) &&
          timestampValue(oldestUpdated) < timestampValue(cutoff)
        ) {
          stoppedAtMergeBound = true;
          complete = !invalidMergeTimestampSeen;
          break;
        }
      }
      if (rows.length < 100) {
        complete = !invalidMergeTimestampSeen;
        break;
      }
    }
    const pullRequests = found.slice(0, limit).map(mapPullRequestMetadata);
    return {
      success: true,
      output: JSON.stringify({
        selection: "latest_merged",
        requested: limit,
        count: pullRequests.length,
        pullRequests,
        complete,
        partial: !complete,
        incompleteReason: complete
          ? null
          : invalidMergeTimestampSeen
            ? "invalid_merge_timestamp_prevented_complete_order_proof"
            : "pagination_page_cap_reached_before_merge_order_was_proven",
        pagesFetched,
        stoppedAtMergeBound,
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
        headRef: readString(
          (pr.head as Record<string, unknown> | undefined)?.ref,
        ),
        headSha: readString(
          (pr.head as Record<string, unknown> | undefined)?.sha,
        ),
        headRepository: readString(
          (toRecord(toRecord(pr.head)?.repo) ?? {}).full_name,
        ),
        baseRef: readString(
          (pr.base as Record<string, unknown> | undefined)?.ref,
        ),
        baseRepository: readString(
          (toRecord(toRecord(pr.base)?.repo) ?? {}).full_name,
        ),
        author: readString(
          (pr.user as Record<string, unknown> | undefined)?.login,
        ),
        body: readString(pr.body),
        merged:
          readBoolean(pr.merged) ??
          (isValidGitHubTimestamp(pr.merged_at) ? true : null),
        mergedAt: readString(pr.merged_at),
        mergeCommitSha: readString(pr.merge_commit_sha),
        createdAt: readString(pr.created_at),
        updatedAt: readString(pr.updated_at),
      }),
    };
  }

  private async getPullRequestFiles(
    payload: GitHubPayload,
    token: string,
  ): Promise<PluginResult> {
    const number = requireNumber(payload.number, "Pull request number");
    const files: Array<Record<string, unknown>> = [];
    let complete = false;
    let pagesFetched = 0;
    for (let page = 1; page <= PULL_REQUEST_FILES_MAX_PAGES; page += 1) {
      const entries = await this.requestGitHub<Array<Record<string, unknown>>>(
        token,
        `/repos/${payload.owner}/${payload.repo}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      pagesFetched = page;
      files.push(...entries);
      if (entries.length < 100) {
        complete = true;
        break;
      }
    }
    const fileOffset = payload.fileOffset ?? 0;
    const fileLimit = payload.fileLimit ?? 20;
    const selectedFiles = payload.fileName
      ? files.filter((file) => readString(file.filename) === payload.fileName)
      : files.slice(fileOffset, fileOffset + fileLimit);
    const outputFiles = selectedFiles.map((file) => {
      const originalPatch = readString(file.patch);
      const patchBytes = originalPatch
        ? Buffer.from(originalPatch, "utf8")
        : null;
      const patchOffset = payload.patchOffset ?? 0;
      const patchLimit = payload.patchLimit ?? MAX_PR_FILE_PATCH_BYTES;
      const patchEnd = patchBytes
        ? Math.min(patchBytes.byteLength, patchOffset + patchLimit)
        : null;
      const patchText =
        patchBytes && patchEnd !== null
          ? patchBytes.subarray(patchOffset, patchEnd).toString("utf8")
          : null;
      const patchTruncated =
        patchBytes !== null &&
        (patchOffset > 0 || (patchEnd ?? 0) < patchBytes.byteLength);
      return {
        fileName: readString(file.filename)?.slice(0, 1_000) ?? null,
        previousFileName:
          readString(file.previous_filename)?.slice(0, 1_000) ?? null,
        status: readString(file.status),
        additions: readNumber(file.additions),
        deletions: readNumber(file.deletions),
        changes: readNumber(file.changes),
        patch: patchText,
        patchAvailability: !originalPatch
          ? "unavailable_unknown"
          : patchTruncated
            ? "windowed"
            : "available",
        binary: "unknown",
        patchTruncated: !originalPatch
          ? "unknown"
          : patchTruncated
            ? "yes"
            : "no",
        patchRange:
          patchBytes && patchEnd !== null
            ? {
                startByte: Math.min(patchOffset, patchBytes.byteLength),
                endByte: patchEnd,
                totalBytes: patchBytes.byteLength,
              }
            : null,
      };
    });
    let localOutputTruncated = false;
    const response = () => {
      const patchOutputTruncated = outputFiles.some(
        (file) => file.patchTruncated === "yes",
      );
      const outputLimitReached = localOutputTruncated || patchOutputTruncated;
      const returnedFileCount = outputFiles.length;
      const nextFileOffset = payload.fileName
        ? null
        : fileOffset + returnedFileCount < files.length
          ? fileOffset + returnedFileCount
          : null;
      return {
        pullRequestNumber: number,
        files: outputFiles,
        count: returnedFileCount,
        sourceFileCount: payload.fileName ? selectedFiles.length : files.length,
        fileOffset: payload.fileName ? null : fileOffset,
        nextFileOffset,
        fileNameFilter: payload.fileName ?? null,
        pagesFetched,
        sourceComplete: complete,
        complete: complete && !outputLimitReached && nextFileOffset === null,
        partial: !complete || outputLimitReached || nextFileOffset !== null,
        incompleteReason:
          !complete && outputLimitReached
            ? "github_file_page_and_output_limits_reached"
            : !complete
              ? "github_file_page_cap_reached"
              : localOutputTruncated
                ? "local_output_limit_reached"
                : patchOutputTruncated
                  ? "patch_window_incomplete"
                  : nextFileOffset !== null
                    ? "more_files_available"
                    : null,
      };
    };
    while (
      outputFiles.length > 0 &&
      utf8ByteLength(JSON.stringify(response())) > MAX_PR_FILES_OUTPUT_BYTES
    ) {
      outputFiles.pop();
      localOutputTruncated = true;
    }
    if (outputFiles.length > 0 && outputFiles.length < selectedFiles.length) {
      localOutputTruncated = true;
    }
    return {
      success: true,
      output: JSON.stringify(response()),
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
          typeof checks.total_count === "number"
            ? checks.total_count
            : checkRuns.length,
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
      const pageComments = await this.requestGitHub<
        Array<Record<string, unknown>>
      >(
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

function isValidGitHubTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function timestampValue(value: unknown): number {
  return isValidGitHubTimestamp(value)
    ? Date.parse(value)
    : Number.NEGATIVE_INFINITY;
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maxBytes) {
      return { text, truncated: true };
    }
    text += character;
    bytes += characterBytes;
  }
  return { text, truncated: false };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function mapPullRequestMetadata(pr: Record<string, unknown>) {
  const head = toRecord(pr.head) ?? {};
  const base = toRecord(pr.base) ?? {};
  return {
    number: readNumber(pr.number),
    title: readString(pr.title),
    state: readString(pr.state),
    draft: readBoolean(pr.draft),
    htmlUrl: readString(pr.html_url),
    headRef: readString(head.ref),
    headSha: readString(head.sha),
    headRepository: readString((toRecord(head.repo) ?? {}).full_name),
    baseRef: readString(base.ref),
    baseRepository: readString((toRecord(base.repo) ?? {}).full_name),
    author: readString((toRecord(pr.user) ?? {}).login),
    body: readString(pr.body),
    merged:
      readBoolean(pr.merged) ??
      (isValidGitHubTimestamp(pr.merged_at) ? true : null),
    mergedAt: readString(pr.merged_at),
    mergeCommitSha: readString(pr.merge_commit_sha),
    createdAt: readString(pr.created_at),
    updatedAt: readString(pr.updated_at),
  };
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
