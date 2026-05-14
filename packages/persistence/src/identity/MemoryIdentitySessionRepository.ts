import type {
  GitHubIdentitySessionInput,
  IdentitySessionRecord,
  IdentitySessionRepository,
} from "./types.js";

interface StoredSession {
  sessionHash: string;
  record: IdentitySessionRecord;
  revokedAt: string | null;
}

export class MemoryIdentitySessionRepository implements IdentitySessionRepository {
  private readonly accountsByProviderId = new Map<string, string>();
  private readonly users = new Map<string, GitHubIdentitySessionInput>();
  private readonly sessions = new Map<string, StoredSession>();

  async createGitHubSession(
    input: GitHubIdentitySessionInput,
  ): Promise<IdentitySessionRecord> {
    const userId =
      this.accountsByProviderId.get(input.providerAccountId) ??
      `user-${this.accountsByProviderId.size + 1}`;
    this.accountsByProviderId.set(input.providerAccountId, userId);
    this.users.set(userId, input);

    const record = buildIdentitySessionRecord(userId, input);
    this.sessions.set(input.sessionHash, {
      sessionHash: input.sessionHash,
      record,
      revokedAt: null,
    });
    return record;
  }

  async findSessionByHash(
    sessionHash: string,
    now: string,
  ): Promise<IdentitySessionRecord | null> {
    const session = this.sessions.get(sessionHash);
    if (!isActiveSession(session, now)) {
      return null;
    }

    return session.record;
  }

  async findLatestGitHubSessionByUserId(
    userId: string,
    now: string,
  ): Promise<IdentitySessionRecord | null> {
    const sessions = Array.from(this.sessions.values())
      .filter(
        (session): session is StoredSession =>
          session.record.userId === userId && isActiveSession(session, now),
      )
      .sort((left, right) => right.record.createdAt - left.record.createdAt);

    return sessions[0]?.record ?? null;
  }

  async revokeSession(sessionHash: string, now: string): Promise<void> {
    const session = this.sessions.get(sessionHash);
    if (session) {
      session.revokedAt = now;
    }
  }
}

function isActiveSession(
  session: StoredSession | undefined,
  now: string,
): session is StoredSession {
  if (!session || session.revokedAt) {
    return false;
  }

  return new Date(session.record.expiresAt).getTime() > new Date(now).getTime();
}

function buildIdentitySessionRecord(
  userId: string,
  input: GitHubIdentitySessionInput,
): IdentitySessionRecord {
  return {
    authSessionId: `session-${input.sessionHash.slice(0, 12)}`,
    userId,
    login: input.login,
    avatar: input.avatarUrl,
    email: input.email,
    name: input.displayName,
    githubScopes: input.scopes,
    encryptedToken: input.encryptedAccessToken,
    createdAt: new Date(input.now).getTime(),
    expiresAt: input.sessionExpiresAt,
  };
}
