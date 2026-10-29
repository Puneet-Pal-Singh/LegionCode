/**
 * GitHub Service for Web Frontend
 *
 * Handles authentication state, repository listing, and GitHub API calls
 */

import { getBrainHttpBase } from "../lib/platform-endpoints.js";
import type { GitCommitIdentityState } from "@repo/shared-types";
import type {
  RepositoryContentsResponse,
  RepositoryReadBranch,
  RepositoryReadRepository,
} from "@repo/platform-protocol";
import {
  getRepositoryTree as getCachedRepositoryTree,
  listRepositoryBranches as listCachedRepositoryBranches,
} from "@legioncode/sdk/platform/repository-read-cache";
import { createHostedAppServerClient } from "./api/appServerClient";
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

export type Repository = RepositoryReadRepository;
export type Branch = RepositoryReadBranch;

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
): Promise<RepositoryContentsResponse> {
  const response = await createHostedAppServerClient({
    timeoutMs: null,
    maxResponseBytes: null,
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
