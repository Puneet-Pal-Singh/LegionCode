import {
  GitHubAPIClient,
  decryptToken,
  type GitHubUser,
} from "@shadowbox/github-bridge";
import type {
  GitCommitIdentity,
  GitCommitIdentityState,
  GitMutationErrorCode,
  GitMutationErrorMetadata,
} from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { getUserSessionByUserId, type UserSessionRecord } from "../AuthService";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CommitIdentityContext {
  userId: string;
  session: UserSessionRecord;
}

interface ExplicitCommitIdentityInput {
  authorName?: string;
  authorEmail?: string;
}

interface GitHubProfileDefaults {
  authorName: string;
  authorEmail: string;
  verified: boolean;
}

export class CommitIdentityError extends Error {
  constructor(
    public readonly code: GitMutationErrorCode,
    message: string,
    public readonly metadata?: GitMutationErrorMetadata,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "CommitIdentityError";
  }
}

export async function readCommitIdentityStateForUser(
  env: Env,
  context: CommitIdentityContext,
): Promise<GitCommitIdentityState> {
  const session = await hydrateGitHubProfileDefaults(env, context);
  return buildGitHubCommitIdentityState(session);
}

export async function resolveCommitIdentityForCommit(
  env: Env,
  context: CommitIdentityContext | null,
  explicitInput?: ExplicitCommitIdentityInput,
): Promise<GitCommitIdentity | null> {
  const trimmedInput = trimExplicitInput(explicitInput);
  if (trimmedInput.authorName || trimmedInput.authorEmail) {
    return resolveExplicitCommitIdentity(trimmedInput);
  }

  if (!context) {
    return null;
  }

  const state = await readCommitIdentityStateForUser(env, context);
  if (state.state === "ready") {
    return state.identity;
  }

  throw new CommitIdentityError(
    "COMMIT_IDENTITY_REQUIRED",
    "Commit author identity is required before LegionCode can commit. Confirm your name and email, then retry.",
    { commitIdentity: state },
  );
}

export async function resolveCommitIdentityForStoredUserSession(
  env: Env,
  userId: string,
  explicitInput?: ExplicitCommitIdentityInput,
): Promise<GitCommitIdentity | null> {
  const session = await getUserSessionByUserId(env, userId);
  if (!session) {
    return null;
  }

  return await resolveCommitIdentityForCommit(
    env,
    {
      userId,
      session,
    },
    explicitInput,
  );
}

export async function resolveCommitIdentityForStoredOAuthSession(
  env: Env,
  userId: string,
): Promise<GitCommitIdentity | null> {
  const session = await getUserSessionByUserId(env, userId);
  if (!session) {
    return null;
  }

  const hydratedSession = await hydrateGitHubProfileDefaults(env, {
    userId,
    session,
  });
  const state = buildGitHubCommitIdentityState(hydratedSession);
  return state.state === "ready" ? state.identity : null;
}

export async function resolveGitHubProfileIdentityFromOAuth(
  accessToken: string,
  user: GitHubUser,
): Promise<GitHubProfileDefaults> {
  return await resolveGitHubProfileDefaults(
    new GitHubAPIClient(accessToken),
    user.id.toString(),
    user.login,
    user.name,
    user.email,
  );
}

function resolveExplicitCommitIdentity(
  input: Required<ExplicitCommitIdentityInput>,
): GitCommitIdentity {
  if (input.authorName.length === 0) {
    throw new CommitIdentityError(
      "COMMIT_IDENTITY_INCOMPLETE",
      "Enter a commit author name before retrying the commit.",
      {
        commitIdentity: {
          state: "requires_input",
          reason: "missing_name",
          suggestedAuthorName: input.authorName,
          suggestedAuthorEmail: input.authorEmail,
        },
      },
    );
  }

  if (!EMAIL_PATTERN.test(input.authorEmail)) {
    throw new CommitIdentityError(
      "COMMIT_IDENTITY_INCOMPLETE",
      "Enter a valid commit author email before retrying the commit.",
      {
        commitIdentity: {
          state: "requires_input",
          reason: "missing_email",
          suggestedAuthorName: input.authorName,
          suggestedAuthorEmail: input.authorEmail,
        },
      },
    );
  }

  return {
    authorName: input.authorName,
    authorEmail: input.authorEmail,
    source: "user_input",
    verified: false,
  };
}

function trimExplicitInput(
  input?: ExplicitCommitIdentityInput,
): Required<ExplicitCommitIdentityInput> {
  return {
    authorName: input?.authorName?.trim() ?? "",
    authorEmail: input?.authorEmail?.trim() ?? "",
  };
}

function buildGitHubCommitIdentityState(
  session: UserSessionRecord,
): GitCommitIdentityState {
  const authorName = resolveAuthorName(session.name, session.login);
  const authorEmail = session.email?.trim() ?? "";
  if (authorName.length > 0 && authorEmail.length > 0) {
    return {
      state: "ready",
      identity: {
        authorName,
        authorEmail,
        source: "github_profile",
        verified: !isGitHubNoreplyEmail(authorEmail),
      },
    };
  }

  return {
    state: "requires_input",
    reason: resolveMissingIdentityReason(authorName, authorEmail),
    suggestedAuthorName: authorName,
    suggestedAuthorEmail: authorEmail,
  };
}

async function hydrateGitHubProfileDefaults(
  env: Env,
  context: CommitIdentityContext,
): Promise<UserSessionRecord> {
  if (hasHydratedGitHubProfile(context.session)) {
    return context.session;
  }

  const accessToken = await decryptToken(
    context.session.encryptedToken,
    env.GITHUB_TOKEN_ENCRYPTION_KEY,
  );
  const defaults = await resolveGitHubProfileDefaults(
    new GitHubAPIClient(accessToken),
    context.userId,
    context.session.login,
    context.session.name ?? null,
    context.session.email,
  );

  const nextSession: UserSessionRecord = {
    ...context.session,
    name: defaults.authorName,
    email: defaults.authorEmail,
  };

  return nextSession;
}

function hasHydratedGitHubProfile(session: UserSessionRecord): boolean {
  const email = session.email?.trim() ?? "";
  return (
    resolveAuthorName(session.name, session.login).length > 0 &&
    email.length > 0 &&
    !isGitHubNoreplyEmail(email)
  );
}

async function resolveGitHubProfileDefaults(
  client: GitHubAPIClient,
  userId: string,
  login: string,
  name: string | null | undefined,
  email: string | null,
): Promise<GitHubProfileDefaults> {
  const authorName = resolveAuthorName(name, login);
  try {
    const emails = await client.listEmails();
    const primaryVerifiedEmail = emails.find(
      (candidate) => candidate.primary && candidate.verified,
    );
    if (primaryVerifiedEmail?.email) {
      return {
        authorName,
        authorEmail: primaryVerifiedEmail.email,
        verified: true,
      };
    }
  } catch (error) {
    console.warn("[git/commit-identity] Failed to fetch GitHub emails", error);
  }

  if (email && email.trim().length > 0) {
    return {
      authorName,
      authorEmail: email.trim(),
      verified: !isGitHubNoreplyEmail(email),
    };
  }

  return {
    authorName,
    authorEmail: buildGitHubNoreplyEmail(userId, login),
    verified: false,
  };
}

function resolveAuthorName(
  name: string | null | undefined,
  login: string,
): string {
  const preferredName = name?.trim();
  if (preferredName && preferredName.length > 0) {
    return preferredName;
  }
  return login.trim();
}

function resolveMissingIdentityReason(
  authorName: string,
  authorEmail: string,
): "missing_identity" | "missing_name" | "missing_email" {
  if (!authorName && !authorEmail) {
    return "missing_identity";
  }
  if (!authorName) {
    return "missing_name";
  }
  return "missing_email";
}

function buildGitHubNoreplyEmail(userId: string, login: string): string {
  return `${userId}+${login}@users.noreply.github.com`;
}

function isGitHubNoreplyEmail(email: string): boolean {
  return email.endsWith("@users.noreply.github.com");
}
