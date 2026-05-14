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

export interface GitHubUser {
  id: string;
  login: string;
  avatar: string;
  email: string | null;
  name: string | null;
  githubScopes?: string[];
  commitIdentity?: GitCommitIdentityState;
}

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
export async function getSession(): Promise<{
  authenticated: boolean;
  user?: GitHubUser;
}> {
  const response = await fetch(
    `${BRAIN_API_URL}/auth/session`,
    getFetchOptions(),
  );

  if (!response.ok) {
    return { authenticated: false };
  }

  const data = await response.json();

  return data;
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

/**
 * Initiate GitHub OAuth flow
 */
export function initiateGitHubLogin(): void {
  window.location.href = `${BRAIN_API_URL}/auth/github/login`;
}

/**
 * Logout user
 */
export async function logout(): Promise<void> {
  await fetch(
    `${BRAIN_API_URL}/auth/logout`,
    getFetchOptions({
      method: "POST",
    }),
  );
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
