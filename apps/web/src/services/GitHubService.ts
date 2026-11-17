/**
 * GitHub Service for Web Frontend
 *
 * Handles authentication state, repository listing, and GitHub API calls
 */

import { getBrainHttpBase } from "../lib/platform-endpoints.js";
import {
  GitHubSessionResponseSchema,
  type GitHubSessionResponse,
} from "@repo/shared-types";
import type {
  RepositoryContentsResponse,
  RepositoryReadBranch,
  RepositoryReadRepository,
} from "@legioncode/sdk";
import {
  getRepositoryTree as getCachedRepositoryTree,
  listRepositoryBranches as listCachedRepositoryBranches,
} from "@legioncode/sdk/platform/repository-read-cache";
import { createHostedAppServerClient } from "./api/appServerClient";

export type { GitHubUser, GitHubSessionResponse } from "@repo/shared-types";

export type Repository = RepositoryReadRepository;
export type Branch = RepositoryReadBranch;

const BRAIN_API_URL = getBrainHttpBase();

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
  const response = await createHostedAppServerClient({
    timeoutMs: null,
    maxResponseBytes: null,
  }).listRepositories({ type, sort });
  return response.repositories;
}

/**
 * List branches for a repository
 */
export async function listBranches(
  owner: string,
  repo: string,
  cacheAccountId: string | null = null,
): Promise<Branch[]> {
  const response = await listCachedRepositoryBranches(
    createHostedAppServerClient({ timeoutMs: null, maxResponseBytes: null }),
    cacheAccountId,
    { owner, repo },
  );
  return response.branches;
}

/**
 * Get repository tree structure
 */
export async function getRepositoryTree(
  owner: string,
  repo: string,
  sha: string = "HEAD",
  cacheAccountId: string | null = null,
): Promise<Array<{ path: string; type: string; sha: string }>> {
  const response = await getCachedRepositoryTree(
    createHostedAppServerClient({ timeoutMs: null, maxResponseBytes: null }),
    cacheAccountId,
    { owner, repo, sha },
  );
  return response.tree;
}

/**
 * Get file content from a repository
 */
export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string = "HEAD",
  signal?: AbortSignal,
): Promise<RepositoryContentsResponse> {
  const response = await createHostedAppServerClient({
    timeoutMs: null,
    maxResponseBytes: null,
    signal,
  }).getRepositoryContents({ owner, repo, path, ref });
  return response.contents;
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
