import {
  DESKTOP_AUTH_INTENT, DesktopAuthChallengeError,
  validateDesktopAuthCreate, validateDesktopAuthConsent, validateDesktopAuthRedeem,
  type CreateDesktopAuthChallengeInput, type PrepareDesktopAuthConsentInput,
  type AuthorizeDesktopAuthChallengeInput, type RedeemDesktopAuthChallengeInput,
  type DesktopAuthConsentRecord, type DesktopAuthRedeemedSession, type DesktopAuthRedeemResult, type DesktopAuthChallengeScope,
} from "./desktop-auth-types.js";
interface StoredDesktopChallenge extends CreateDesktopAuthChallengeInput {
  consentSessionId: string | null; csrfHash: string | null;
  authorizedSourceSessionId: string | null; authorizedAt: string | null; consumedAt: string | null;
}
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
  private readonly desktopChallenges = new Map<string, StoredDesktopChallenge>();

  async createDesktopAuthChallenge(input: CreateDesktopAuthChallengeInput): Promise<void> {
    validateDesktopAuthCreate(input);
    if (this.desktopChallenges.has(input.challengeIdHash)) throw new DesktopAuthChallengeError("challenge_conflict", "Desktop authentication challenge already exists");
    this.desktopChallenges.set(input.challengeIdHash, { ...input, consentSessionId: null, csrfHash: null, authorizedSourceSessionId: null, authorizedAt: null, consumedAt: null });
  }
  async prepareDesktopAuthConsent(input: PrepareDesktopAuthConsentInput): Promise<boolean> {
    validateDesktopAuthConsent(input);
    const challenge = this.usableDesktopChallenge(input);
    const source = this.sessions.get(input.sourceSessionHash);
    if (!challenge || challenge.authorizedAt !== null || !isActiveSession(source,input.now) || (challenge.consentSessionId !== null && challenge.consentSessionId !== source.record.authSessionId)) return false;
    challenge.consentSessionId=source.record.authSessionId; challenge.csrfHash=input.csrfHash;
    return true;
  }
  async authorizeDesktopAuthChallenge(input: AuthorizeDesktopAuthChallengeInput): Promise<boolean> {
    validateDesktopAuthConsent(input);
    const challenge = this.usableDesktopChallenge(input);
    const source = this.sessions.get(input.sourceSessionHash);
    if (!challenge || challenge.authorizedAt !== null || !isActiveSession(source,input.now) || challenge.consentSessionId !== source.record.authSessionId || challenge.csrfHash !== input.csrfHash) return false;
    challenge.authorizedSourceSessionId=source.record.authSessionId; challenge.authorizedAt=input.now;
    return true;
  }
  async redeemDesktopAuthChallenge(input: RedeemDesktopAuthChallengeInput): Promise<DesktopAuthRedeemResult> {
    validateDesktopAuthRedeem(input);
    // No await between checking/claiming and updating the existing session map.
    const challenge = this.usableDesktopChallenge(input);
    if (!challenge || challenge.verifierChallenge !== input.verifierChallenge) return {status:"invalid"};
    if (!challenge.authorizedAt) return {status:"pending"};
    if (challenge.authorizedSourceSessionId !== challenge.consentSessionId) return {status:"invalid"};
    const source=Array.from(this.sessions.values()).find((value) => value.record.authSessionId === challenge.authorizedSourceSessionId);
    if (!isActiveSession(source,input.now) || source.sessionHash === input.sessionHash) return {status:"invalid"};
    if (this.sessions.has(input.sessionHash)) throw new DesktopAuthChallengeError("session_hash_conflict", "Desktop authentication session could not be created");
    const expiresAt = new Date(Math.min(Date.parse(input.sessionExpiresAt),Date.parse(source.record.expiresAt))).toISOString();
    const record: IdentitySessionRecord={...source.record,authSessionId:crypto.randomUUID(),createdAt:Date.parse(input.now),expiresAt};
    this.sessions.set(input.sessionHash,{sessionHash:input.sessionHash,record,revokedAt:null});
    challenge.consumedAt=input.now;
    return {status:"issued",authSessionId:record.authSessionId,userId:record.userId,expiresAt};
  }
  private usableDesktopChallenge(input: DesktopAuthChallengeScope): StoredDesktopChallenge | null {
    const challenge=this.desktopChallenges.get(input.challengeIdHash);
    return challenge && challenge.origin === input.origin && challenge.intent === input.intent && challenge.consumedAt === null && Date.parse(challenge.expiresAt)>Date.parse(input.now) ? challenge : null;
  }

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
