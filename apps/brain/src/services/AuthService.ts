/**
 * AuthService
 *
 * Shared authentication utilities for opaque cookie sessions.
 */

import {
  DatabaseConfigurationError,
  persistenceMigrations,
  PostgresIdentitySessionRepository,
  PostgresMigrationLedger,
  PostgresMigrationRunner,
  readWorkerDatabaseConfig,
  withPostgresSqlClient,
  type DatabaseMigrationsMode,
  type IdentitySessionRecord,
  type IdentitySessionRepository,
  type SqlClient,
  type WorkerDatabaseConfig,
} from "@repo/persistence";
import {
  GitHubAPIClient,
  decryptToken,
  type EncryptedToken,
} from "@shadowbox/github-bridge";
import type { GitCommitIdentityState } from "@repo/shared-types";
import { DependencyError } from "../domain/errors";
import type { Env } from "../types/ai";

const SESSION_COOKIE_NAME = "shadowbox_session";
const AUTH_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const AUTH_SESSION_TTL_MS = AUTH_SESSION_TTL_SECONDS * 1000;
const SESSION_TOKEN_BYTES = 32;

export interface UserSessionRecord {
  userId: string;
  login: string;
  avatar: string;
  email: string | null;
  name?: string | null;
  githubScopes?: string[];
  encryptedToken: EncryptedToken;
  createdAt: number;
  commitIdentity?: GitCommitIdentityState;
  workspaceId?: string;
  defaultWorkspaceId?: string;
  workspaceIds?: string[];
}

export interface CreateGitHubOAuthSessionInput {
  providerAccountId: string;
  login: string;
  avatarUrl: string;
  email: string | null;
  displayName: string | null;
  accessToken: string;
  encryptedToken: EncryptedToken;
  scopes: string[];
  tokenExpiresInSeconds?: number | null;
}

export interface CreatedGitHubOAuthSession {
  sessionToken: string;
  session: UserSessionRecord;
  expiresAt: string;
}

export interface AuthResult {
  client: GitHubAPIClient;
  userId: string;
  session: UserSessionRecord;
}

export class SessionStoreUnavailableError extends Error {
  constructor() {
    super("Session store is temporarily unavailable. Please retry.");
    this.name = "SessionStoreUnavailableError";
  }
}

export function isSessionStoreUnavailableError(
  error: unknown,
): error is SessionStoreUnavailableError {
  return error instanceof SessionStoreUnavailableError;
}

export function createSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${AUTH_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function createExpiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

export function extractSessionToken(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) {
    return null;
  }

  const match = cookie.match(/(?:^|;\s*)shadowbox_session=([^;]+)/);
  if (!match?.[1]) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export async function createGitHubOAuthSession(
  env: Env,
  input: CreateGitHubOAuthSessionInput,
): Promise<CreatedGitHubOAuthSession> {
  const now = new Date();
  const token = generateOpaqueSessionToken();
  const sessionHash = await hashSessionToken(token);
  const tokenFingerprint = await hashSecret(input.accessToken);
  const tokenExpiresAt = resolveTokenExpiresAt(
    input.tokenExpiresInSeconds,
    now,
  );
  const sessionExpiresAt = new Date(now.getTime() + AUTH_SESSION_TTL_MS);

  const record = await withIdentitySessionRepository(env, (repository) =>
    repository.createGitHubSession({
      providerAccountId: input.providerAccountId,
      login: input.login,
      avatarUrl: input.avatarUrl,
      email: input.email,
      displayName: input.displayName,
      encryptedAccessToken: input.encryptedToken,
      tokenFingerprint,
      scopes: input.scopes,
      tokenExpiresAt: tokenExpiresAt?.toISOString() ?? null,
      sessionHash,
      sessionExpiresAt: sessionExpiresAt.toISOString(),
      now: now.toISOString(),
    }),
  );

  return {
    sessionToken: token,
    session: mapIdentitySession(record),
    expiresAt: record.expiresAt,
  };
}

export async function verifySessionToken(
  token: string,
  env: Env,
): Promise<string | null> {
  const session = await findSessionByToken(env, token);
  return session?.userId ?? null;
}

export async function getGitHubClient(
  request: Request,
  env: Env,
): Promise<AuthResult | null> {
  const authenticatedSession = await getAuthenticatedUserSession(request, env);
  if (!authenticatedSession) {
    return null;
  }

  const { userId, session } = authenticatedSession;
  const accessToken = await decryptToken(
    session.encryptedToken,
    env.GITHUB_TOKEN_ENCRYPTION_KEY,
  );

  return {
    client: new GitHubAPIClient(accessToken),
    userId,
    session,
  };
}

export async function getAuthenticatedUserSession(
  request: Request,
  env: Env,
): Promise<{ userId: string; session: UserSessionRecord } | null> {
  const sessionToken = extractSessionToken(request);
  if (!sessionToken) {
    console.warn("[auth/session] missing session cookie on request");
    return null;
  }

  const session = await findSessionByToken(env, sessionToken);
  if (!session) {
    console.warn("[auth/session] session cookie failed verification");
    return null;
  }

  return { userId: session.userId, session };
}

export async function getUserSessionByUserId(
  env: Env,
  userId: string,
): Promise<UserSessionRecord | null> {
  return await readSessionRecord(env, (repository, now) =>
    repository.findLatestGitHubSessionByUserId(userId, now),
  );
}

export async function revokeAuthenticatedSession(
  request: Request,
  env: Env,
): Promise<void> {
  const sessionToken = extractSessionToken(request);
  if (!sessionToken) {
    return;
  }

  const sessionHash = await hashSessionToken(sessionToken);
  await withIdentitySessionRepository(env, (repository) =>
    repository.revokeSession(sessionHash, new Date().toISOString()),
  );
}

export async function hashSessionToken(token: string): Promise<string> {
  return await hashSecret(token);
}

async function findSessionByToken(
  env: Env,
  token: string,
): Promise<UserSessionRecord | null> {
  const sessionHash = await hashSessionToken(token);
  return await readSessionRecord(env, (repository, now) =>
    repository.findSessionByHash(sessionHash, now),
  );
}

async function readSessionRecord(
  env: Env,
  read: (
    repository: IdentitySessionRepository,
    now: string,
  ) => Promise<IdentitySessionRecord | null>,
): Promise<UserSessionRecord | null> {
  try {
    const now = new Date().toISOString();
    const record = await withIdentitySessionRepository(env, (repository) =>
      read(repository, now),
    );
    return record ? mapIdentitySession(record) : null;
  } catch (error) {
    console.warn("[auth/session] failed to read session record", {
      error: formatUnknownError(error),
    });
    throw new SessionStoreUnavailableError();
  }
}

async function withIdentitySessionRepository<T>(
  env: Env,
  callback: (repository: IdentitySessionRepository) => Promise<T>,
): Promise<T> {
  if (env.AUTH_IDENTITY_REPOSITORY) {
    return await callback(env.AUTH_IDENTITY_REPOSITORY);
  }

  const databaseConfig = readBrainDatabaseConfig(env);
  return await withPostgresSqlClient(
    databaseConfig.connectionString,
    async (client) => {
      await runAutomaticMigrations(databaseConfig.migrationsMode, client);
      return await callback(new PostgresIdentitySessionRepository(client));
    },
  );
}

function readBrainDatabaseConfig(env: Env): WorkerDatabaseConfig {
  try {
    return readWorkerDatabaseConfig(env);
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) {
      throw new DependencyError(error.message, error.code, false);
    }

    throw error;
  }
}

async function runAutomaticMigrations(
  migrationsMode: DatabaseMigrationsMode,
  client: SqlClient,
): Promise<void> {
  if (migrationsMode !== "auto") {
    return;
  }

  const runner = new PostgresMigrationRunner(
    client,
    new PostgresMigrationLedger(),
  );
  await runner.runPending(persistenceMigrations);
}

function generateOpaqueSessionToken(): string {
  const bytes = new Uint8Array(SESSION_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function resolveTokenExpiresAt(
  expiresInSeconds: number | null | undefined,
  now: Date,
): Date | null {
  if (!expiresInSeconds || expiresInSeconds <= 0) {
    return null;
  }

  return new Date(now.getTime() + expiresInSeconds * 1000);
}

function mapIdentitySession(record: IdentitySessionRecord): UserSessionRecord {
  const workspaceClaims = readWorkspaceClaims(record);
  return {
    userId: record.userId,
    login: record.login,
    avatar: record.avatar,
    email: record.email,
    name: record.name,
    githubScopes: record.githubScopes,
    encryptedToken: record.encryptedToken,
    createdAt: record.createdAt,
    ...workspaceClaims,
  };
}

function readWorkspaceClaims(
  record: IdentitySessionRecord,
): Pick<
  UserSessionRecord,
  "workspaceId" | "defaultWorkspaceId" | "workspaceIds"
> {
  return {
    workspaceId: record.workspaceId,
    defaultWorkspaceId: record.defaultWorkspaceId,
    workspaceIds: record.workspaceIds,
  };
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
