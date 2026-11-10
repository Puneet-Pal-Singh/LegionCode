import { z } from "zod";
import type { GitCommitIdentityState } from "./git.js";

/** Existing hosted cookie-session response shape; authentication stays server-owned. */
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

export const GitHubUserSchema = z.object({
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

export const GitHubSessionResponseSchema = z.discriminatedUnion("authenticated", [
  z.object({
    authenticated: z.literal(true),
    user: GitHubUserSchema,
  }).passthrough(),
  z.object({
    authenticated: z.literal(false),
    user: z.undefined().optional(),
  }).passthrough(),
]);

