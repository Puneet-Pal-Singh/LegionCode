export interface EncryptedOAuthToken {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface GitHubIdentitySessionInput {
  providerAccountId: string;
  login: string;
  avatarUrl: string;
  email: string | null;
  displayName: string | null;
  encryptedAccessToken: EncryptedOAuthToken;
  tokenFingerprint: string;
  scopes: string[];
  tokenExpiresAt?: string | null;
  sessionHash: string;
  sessionExpiresAt: string;
  now: string;
}

export interface IdentitySessionRecord {
  authSessionId: string;
  userId: string;
  login: string;
  avatar: string;
  email: string | null;
  name: string | null;
  githubScopes: string[];
  encryptedToken: EncryptedOAuthToken;
  createdAt: number;
  expiresAt: string;
  workspaceId?: string;
  defaultWorkspaceId?: string;
  workspaceIds?: string[];
}

export interface IdentitySessionRepository {
  createGitHubSession(
    input: GitHubIdentitySessionInput,
  ): Promise<IdentitySessionRecord>;
  findSessionByHash(
    sessionHash: string,
    now: string,
  ): Promise<IdentitySessionRecord | null>;
  findLatestGitHubSessionByUserId(
    userId: string,
    now: string,
  ): Promise<IdentitySessionRecord | null>;
  revokeSession(sessionHash: string, now: string): Promise<void>;
}
