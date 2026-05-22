/**
 * GitHubController
 *
 * Handles GitHub API operations for repository management
 * Part of the Control Plane (Brain)
 * Follows Single Responsibility: Only handles GitHub API routes
 */

import { getCorsHeaders } from "../lib/cors";
import { Env } from "../types/ai";
import {
  getGitHubClient,
  isSessionStoreUnavailableError,
} from "../services/AuthService";
import type { CreatePullRequestParams } from "@shadowbox/github-bridge";
import type {
  CreatePullRequestPayload,
  GitPullRequestMutationResult,
} from "@repo/shared-types";
import { getBrainRuntimeHeaders } from "../core/observability/runtime";

/**
 * JSON response helper with env-aware CORS policy
 */
function envJsonResponse(
  request: Request,
  env: Env,
  data: unknown,
  status: number = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getBrainRuntimeHeaders(env),
      ...getCorsHeaders(request, env),
    },
  });
}

/**
 * Error response helper
 */
function errorResponse(
  request: Request,
  env: Env,
  message: string,
  status: number,
): Response {
  return envJsonResponse(request, env, { error: message }, status);
}

export class GitHubController {
  /**
   * List user's repositories
   * GET /api/github/repos
   */
  static async listRepositories(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getGitHubClient(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { client } = auth;

      const url = new URL(request.url);
      const type =
        (url.searchParams.get("type") as "all" | "owner" | "member") || "all";
      const sort =
        (url.searchParams.get("sort") as
          | "created"
          | "updated"
          | "pushed"
          | "full_name") || "updated";
      const perPage = parseInt(url.searchParams.get("per_page") || "30", 10);

      const repos = await client.listRepositories(type, sort, perPage);

      return envJsonResponse(request, env, { repositories: repos });
    } catch (error) {
      return handleGitHubControllerError(
        request,
        env,
        error,
        "[GitHub] List repos error:",
        "Failed to list repositories",
      );
    }
  }

  /**
   * List branches for a repository
   * GET /api/github/branches?owner=xxx&repo=xxx
   */
  static async listBranches(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getGitHubClient(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { client } = auth;

      const url = new URL(request.url);
      const owner = url.searchParams.get("owner");
      const repo = url.searchParams.get("repo");
      const rawPerPage = parseInt(url.searchParams.get("per_page") || "100", 10);
      const perPage = Number.isFinite(rawPerPage)
        ? Math.min(100, Math.max(1, rawPerPage))
        : 100;

      if (!owner || !repo) {
        return errorResponse(
          request,
          env,
          "Missing owner or repo parameter",
          400,
        );
      }

      const branches = await client.listBranches(owner, repo, perPage);

      return envJsonResponse(request, env, { branches });
    } catch (error) {
      return handleGitHubControllerError(
        request,
        env,
        error,
        "[GitHub] List branches error:",
        "Failed to list branches",
      );
    }
  }

  /**
   * Get repository contents
   * GET /api/github/contents?owner=xxx&repo=xxx&path=xxx&ref=xxx
   */
  static async getContents(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getGitHubClient(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { client } = auth;

      const url = new URL(request.url);
      const owner = url.searchParams.get("owner");
      const repo = url.searchParams.get("repo");
      const path = url.searchParams.get("path") || "";
      const ref = url.searchParams.get("ref") || undefined;

      if (!owner || !repo) {
        return errorResponse(
          request,
          env,
          "Missing owner or repo parameter",
          400,
        );
      }

      const contents = await client.getContents(owner, repo, path, ref);

      return envJsonResponse(request, env, { contents });
    } catch (error) {
      return handleGitHubControllerError(
        request,
        env,
        error,
        "[GitHub] Get contents error:",
        "Failed to get contents",
      );
    }
  }

  /**
   * Get repository file tree
   * GET /api/github/tree?owner=xxx&repo=xxx&sha=xxx
   */
  static async getTree(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getGitHubClient(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { client } = auth;

      const url = new URL(request.url);
      const owner = url.searchParams.get("owner");
      const repo = url.searchParams.get("repo");
      const sha = url.searchParams.get("sha") || "HEAD";

      if (!owner || !repo) {
        return errorResponse(
          request,
          env,
          "Missing owner or repo parameter",
          400,
        );
      }

      const treeResult = await getTreeWithDefaultBranchFallback(
        client,
        owner,
        repo,
        sha,
      );

      return envJsonResponse(request, env, treeResult);
    } catch (error) {
      return handleGitHubControllerError(
        request,
        env,
        error,
        "[GitHub] Get tree error:",
        "Failed to get tree",
      );
    }
  }

  /**
   * List pull requests for a repository
   * GET /api/github/pulls?owner=xxx&repo=xxx&state=xxx
   */
  static async listPullRequests(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getGitHubClient(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { client } = auth;

      const url = new URL(request.url);
      const owner = url.searchParams.get("owner");
      const repo = url.searchParams.get("repo");
      const state =
        (url.searchParams.get("state") as "open" | "closed" | "all") || "open";
      const head = url.searchParams.get("head") || undefined;
      const rawPerPage = parseInt(url.searchParams.get("per_page") || "100", 10);
      const perPage = Number.isFinite(rawPerPage)
        ? Math.min(100, Math.max(1, rawPerPage))
        : 100;

      if (!owner || !repo) {
        return errorResponse(
          request,
          env,
          "Missing owner or repo parameter",
          400,
        );
      }

      const pullRequests = await client.listPullRequests(owner, repo, state, {
        head,
        perPage,
      });

      return envJsonResponse(request, env, { pullRequests });
    } catch (error) {
      return handleGitHubControllerError(
        request,
        env,
        error,
        "[GitHub] List PRs error:",
        "Failed to list pull requests",
      );
    }
  }

  /**
   * Get a single pull request
   * GET /api/github/pulls/:number?owner=xxx&repo=xxx
   */
  static async getPullRequest(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getGitHubClient(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { client } = auth;

      const url = new URL(request.url);
      const owner = url.searchParams.get("owner");
      const repo = url.searchParams.get("repo");
      const pathParts = url.pathname.split("/");
      const numberStr = pathParts[pathParts.length - 1];
      const number = numberStr ? parseInt(numberStr, 10) : NaN;

      if (!owner || !repo || isNaN(number)) {
        return errorResponse(
          request,
          env,
          "Missing or invalid parameters",
          400,
        );
      }

      const pullRequest = await client.getPullRequest(owner, repo, number);

      return envJsonResponse(request, env, { pullRequest });
    } catch (error) {
      return handleGitHubControllerError(
        request,
        env,
        error,
        "[GitHub] Get PR error:",
        "Failed to get pull request",
      );
    }
  }

  /**
   * Create a pull request
   * POST /api/github/pulls
   */
  static async createPullRequest(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      const auth = await getGitHubClient(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { client } = auth;

      const body = (await request.json()) as Partial<CreatePullRequestPayload>;

      const owner = body.owner;
      const repo = body.repo;
      const title = body.title;
      const head = body.head;
      const base = body.base;

      if (!owner || !repo || !title || !head || !base) {
        return errorResponse(request, env, "Missing required parameters", 400);
      }

      const params: CreatePullRequestParams = {
        title,
        head,
        base,
        body: body.body,
      };

      const pullRequest = await client.createPullRequest(owner, repo, params);

      return envJsonResponse(
        request,
        env,
        {
          success: true,
          pullRequest: {
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.html_url,
            state: pullRequest.state,
            head: pullRequest.head.ref,
            base: pullRequest.base.ref,
          },
        } satisfies GitPullRequestMutationResult,
        201,
      );
    } catch (error) {
      const resolvedError = resolveGitHubControllerError(error);
      if (resolvedError.status >= 500) {
        console.error("[GitHub] Create PR error:", error);
      } else {
        console.warn("[GitHub] Create PR warning:", error);
      }
      return envJsonResponse(
        request,
        env,
        {
          error: resolvedError.message,
          code: "PR_CREATION_FAILED",
        },
        resolvedError.status,
      );
    }
  }
}

type GitHubTreeClient = {
  getTree(
    owner: string,
    repo: string,
    sha?: string,
  ): Promise<Array<{ path: string; type: string; sha: string; size?: number }>>;
  getRepository(
    owner: string,
    repo: string,
  ): Promise<{ default_branch: string }>;
};

async function getTreeWithDefaultBranchFallback(
  client: GitHubTreeClient,
  owner: string,
  repo: string,
  sha: string,
): Promise<{
  tree: Array<{ path: string; type: string; sha: string; size?: number }>;
  requestedRefUnavailable?: boolean;
  resolvedRef?: string;
}> {
  try {
    return { tree: await client.getTree(owner, repo, sha) };
  } catch (error) {
    if (!isGitHubApiStatus(error, 404)) {
      throw error;
    }

    const repository = await client.getRepository(owner, repo);
    const defaultBranch = repository.default_branch;
    if (!defaultBranch || defaultBranch === sha) {
      throw error;
    }

    console.warn("[GitHub] Tree ref unavailable; using default branch tree:", {
      owner,
      repo,
      sha,
      defaultBranch,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      tree: await client.getTree(owner, repo, defaultBranch),
      requestedRefUnavailable: true,
      resolvedRef: defaultBranch,
    };
  }
}

function handleGitHubControllerError(
  request: Request,
  env: Env,
  error: unknown,
  logLabel: string,
  fallbackMessage: string,
): Response {
  const resolvedError = resolveGitHubControllerError(error);
  if (resolvedError.status >= 500) {
    console.error(logLabel, error);
  } else {
    console.warn(logLabel, error);
  }

  const message =
    error instanceof Error ? error.message : fallbackMessage;
  return errorResponse(
    request,
    env,
    resolvedError.status === 500 ? message : resolvedError.message,
    resolvedError.status,
  );
}

function resolveGitHubControllerError(error: unknown): {
  status: number;
  message: string;
} {
  if (isSessionStoreUnavailableError(error)) {
    return {
      status: 503,
      message: "Session store is temporarily unavailable. Please retry.",
    };
  }

  return {
    status: 500,
    message:
      error instanceof Error ? error.message : "GitHub API request failed",
  };
}

function isGitHubApiStatus(error: unknown, status: number): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes(`GitHub API error (${status})`);
}
