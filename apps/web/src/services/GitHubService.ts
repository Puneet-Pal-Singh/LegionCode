/**
 * GitHub Service for Web Frontend
 *
 * Handles authentication state, repository listing, and GitHub API calls
 */

import {
  getBrainHttpBase,
  githubPullsPath,
} from "../lib/platform-endpoints.js";
import type {
  CreatePullRequestPayload,
  GitCommitIdentityState,
  GitPullRequestMutationResult,
} from "@repo/shared-types";
import { GitMutationError } from "../lib/git-client.js";
import { z } from "zod";

export interface GitHubUser {
  id: string;
  login: string;
  avatar: string;
  email: string | null;
  name: string | null;
  githubScopes?: string[];
  commitIdentity?: GitCommitIdentityState;
  workspaceId?: string;
  defaultWorkspaceId?: string;
  workspaceIds?: string[];
}

export type GitHubSessionResponse =
  | { authenticated: true; user: GitHubUser }
  | { authenticated: false; user?: undefined };

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  stargazers_count: number;
  language: string | null;
  updated_at: string;
}

export interface Branch {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  protected: boolean;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  head: string;
  base: string;
}

const PullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  html_url: z.string().url(),
  head: z.object({ ref: z.string() }),
  base: z.object({ ref: z.string() }),
});

const PullRequestListSchema = z.object({
  pullRequests: z.array(PullRequestSchema),
});

const GitCommitIdentitySchema = z.object({
  authorName: z.string(),
  authorEmail: z.string(),
  source: z.enum(["workspace_git_config", "github_profile", "user_input"]),
  verified: z.boolean(),
}).passthrough();

const GitCommitIdentityStateSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    identity: GitCommitIdentitySchema,
  }).passthrough(),
  z.object({
    state: z.literal("requires_input"),
    reason: z.enum(["missing_identity", "missing_name", "missing_email"]),
    suggestedAuthorName: z.string(),
    suggestedAuthorEmail: z.string(),
  }).passthrough(),
]);

const GitHubUserSchema = z.object({
  id: z.string(),
  login: z.string(),
  avatar: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  githubScopes: z.array(z.string()).optional(),
  commitIdentity: GitCommitIdentityStateSchema.optional(),
  workspaceId: z.string().optional(),
  defaultWorkspaceId: z.string().optional(),
  workspaceIds: z.array(z.string()).optional(),
}).passthrough();

const GitHubSessionResponseSchema = z.discriminatedUnion("authenticated", [
  z.object({
    authenticated: z.literal(true),
    user: GitHubUserSchema,
  }).passthrough(),
  z.object({
    authenticated: z.literal(false),
    user: z.undefined().optional(),
  }).passthrough(),
]);

const BRAIN_API_URL = getBrainHttpBase();
const REQUEST_CACHE_TTL_MS = 15_000;

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

const branchesCache = new Map<string, CacheEntry<Branch[]>>();
const branchesInFlight = new Map<string, Promise<Branch[]>>();
const treeCache = new Map<
  string,
  CacheEntry<Array<{ path: string; type: string; sha: string }>>
>();
const treeInFlight = new Map<
  string,
  Promise<Array<{ path: string; type: string; sha: string }>>
>();

function getFetchOptions(options: RequestInit = {}): RequestInit {
  const headers = new Headers(options.headers || {});

  return {
    ...options,
    headers,
    credentials: "include",
  };
}

/**
 * Get current session from Brain API
 */
export async function getSession(): Promise<GitHubSessionResponse> {
  const response = await fetch(
    `${BRAIN_API_URL}/auth/session`,
    getFetchOptions(),
  );

  if (!response.ok) {
    throw new Error(`Session check unavailable: HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Session response was not valid JSON");
  }

  const result = GitHubSessionResponseSchema.safeParse(body);
  if (!result.success) {
    throw new Error("Session response had an invalid contract");
  }

  return result.data;
}

export async function createPullRequest(
  payload: CreatePullRequestPayload,
): Promise<PullRequestSummary> {
  const response = await fetch(
    githubPullsPath(),
    getFetchOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );

  if (!response.ok) {
    throw await readGitHubMutationError(
      response,
      `Failed to create pull request: HTTP ${response.status}`,
      "PR_CREATION_FAILED",
    );
  }

  const data = (await response.json()) as GitPullRequestMutationResult;
  return data.pullRequest;
}

export async function listOpenPullRequests(
  owner: string,
  repo: string,
  branch: string,
): Promise<PullRequestSummary[]> {
  const query = new URLSearchParams({
    owner,
    repo,
    state: "open",
    head: branch,
  });
  const response = await fetch(
    `${githubPullsPath()}?${query.toString()}`,
    getFetchOptions(),
  );
  if (!response.ok) {
    throw new Error(`Failed to list pull requests: HTTP ${response.status}`);
  }

  const data = PullRequestListSchema.parse(await response.json());
  return data.pullRequests.map((pullRequest) => ({
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.html_url,
    state: pullRequest.state,
    head: pullRequest.head.ref,
    base: pullRequest.base.ref,
  }));
}

/**
 * Initiate GitHub OAuth flow
 */
export function initiateGitHubLogin(): void {
  window.location.href = `${BRAIN_API_URL}/auth/github/login`;
}

/**
 * Reauthorize GitHub after a revoked or insufficient OAuth grant.
 * The callback replaces the persisted encrypted session through the normal
 * control-plane OAuth flow; no token is kept in the browser URL or logs.
 */
export function initiateGitHubReauthorization(): void {
  window.location.href = `${BRAIN_API_URL}/auth/github/reauthorize`;
}

/**
 * Logout user
 */
export async function logout(): Promise<void> {
  const response = await fetch(
    `${BRAIN_API_URL}/auth/logout`,
    getFetchOptions({
      method: "POST",
    }),
  );
  if (!response.ok) {
    throw new Error(`Logout failed with status ${response.status}`);
  }
}

/**
 * List user's repositories
 */
export async function listRepositories(
  type: "all" | "owner" | "member" = "all",
  sort: "created" | "updated" | "pushed" | "full_name" = "updated",
): Promise<Repository[]> {
  const response = await fetch(
    `${BRAIN_API_URL}/api/github/repos?type=${type}&sort=${sort}`,
    getFetchOptions(),
  );

  if (!response.ok) {
    throw new Error("Failed to fetch repositories");
  }

  const data = await response.json();
  return data.repositories;
}

/**
 * List branches for a repository
 */
export async function listBranches(
  owner: string,
  repo: string,
): Promise<Branch[]> {
  const cacheKey = `${owner}:${repo}`;
  const cachedBranches = readFreshCache(branchesCache, cacheKey);
  if (cachedBranches) {
    return cachedBranches;
  }

  const inFlightBranches = branchesInFlight.get(cacheKey);
  if (inFlightBranches) {
    return inFlightBranches;
  }

  const request = (async (): Promise<Branch[]> => {
    const response = await fetch(
      `${BRAIN_API_URL}/api/github/branches?owner=${owner}&repo=${repo}`,
      getFetchOptions(),
    );

    if (!response.ok) {
      const message = await readGitHubErrorMessage(response);
      if (shouldFallbackToEmptyBranches(response.status, message)) {
        console.warn(
          "[github/branches] falling back to empty branch list due to transient server error",
          { status: response.status, message },
        );
        writeCache(branchesCache, cacheKey, []);
        return [];
      }
      throw new Error(message || "Failed to fetch branches");
    }

    const data = await response.json();
    const branches = data.branches as Branch[];
    writeCache(branchesCache, cacheKey, branches);
    return branches;
  })();

  branchesInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (branchesInFlight.get(cacheKey) === request) {
      branchesInFlight.delete(cacheKey);
    }
  }
}

function shouldFallbackToEmptyBranches(
  status: number,
  message: string,
): boolean {
  if (status >= 500) {
    return true;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("session store is temporarily unavailable") ||
    normalized.includes("kv get failed") ||
    normalized.includes("not a git repository")
  );
}

/**
 * Get repository tree structure
 */
export async function getRepositoryTree(
  owner: string,
  repo: string,
  sha: string = "HEAD",
): Promise<Array<{ path: string; type: string; sha: string }>> {
  const cacheKey = `${owner}:${repo}:${sha}`;
  const cachedTree = readFreshCache(treeCache, cacheKey);
  if (cachedTree) {
    return cachedTree;
  }

  const inFlightTree = treeInFlight.get(cacheKey);
  if (inFlightTree) {
    return inFlightTree;
  }

  const request = (async (): Promise<
    Array<{ path: string; type: string; sha: string }>
  > => {
    const response = await fetch(
      `${BRAIN_API_URL}/api/github/tree?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}`,
      getFetchOptions(),
    );

    if (!response.ok) {
      const message = await readGitHubErrorMessage(response);
      if (response.status >= 500 || message.includes("not a git repository")) {
        console.warn(
          "[github/tree] falling back to empty tree due to server error",
          { status: response.status, message },
        );
        writeCache(treeCache, cacheKey, []);
        return [];
      }
      throw new Error(message || "Failed to fetch tree");
    }

    const data = await response.json();
    const tree = data.tree as Array<{
      path: string;
      type: string;
      sha: string;
    }>;
    writeCache(treeCache, cacheKey, tree);
    return tree;
  })();

  treeInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (treeInFlight.get(cacheKey) === request) {
      treeInFlight.delete(cacheKey);
    }
  }
}

async function readGitHubErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Failed to fetch tree: HTTP ${response.status}`;
  } catch {
    return `Failed to fetch tree: HTTP ${response.status}`;
  }
}

async function readGitHubMutationError(
  response: Response,
  fallbackMessage: string,
  fallbackCode: "PR_CREATION_FAILED",
): Promise<Error> {
  try {
    const payload = (await response.json()) as {
      error?: string;
      code?: string;
    };
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      return new GitMutationError(
        payload.error,
        (payload.code as "PR_CREATION_FAILED" | undefined) ?? fallbackCode,
      );
    }
  } catch {
    // Fall through to the generic error below.
  }

  return new GitMutationError(fallbackMessage, fallbackCode);
}

function readFreshCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): T | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.timestamp > REQUEST_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function writeCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
): void {
  cache.set(key, {
    value,
    timestamp: Date.now(),
  });
}

/**
 * Get file content from a repository
 */
export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string = "HEAD",
): Promise<{ content: string; sha: string; size: number; encoding: string }> {
  const response = await fetch(
    `${BRAIN_API_URL}/api/github/contents?owner=${owner}&repo=${repo}&path=${encodeURIComponent(path)}&ref=${ref}`,
    getFetchOptions(),
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch file content: ${response.statusText}`);
  }

  const data = await response.json();
  return data.contents;
}

/**
 * Handle OAuth callback cleanup.
 */
export function handleOAuthCallback(): {
  user: string | null;
  success: boolean;
} {
  const params = new URLSearchParams(window.location.search);
  const user = params.get("user");
  const hadLegacySessionParams = params.has("session") || params.has("user");

  if (hadLegacySessionParams) {
    window.history.replaceState({}, document.title, window.location.pathname);
    return { user, success: true };
  }

  return { user: null, success: false };
}
