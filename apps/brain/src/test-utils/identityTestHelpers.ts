import type {
  EncryptedOAuthToken,
  IdentitySessionRecord,
  IdentitySessionRepository,
  WorkspaceRepository,
  WorkspaceBootstrapRecord,
} from "@repo/persistence";

export const TEST_ENCRYPTED_OAUTH_TOKEN: EncryptedOAuthToken = {
  ciphertext: "ciphertext",
  iv: "iv",
  tag: "tag",
};

export interface IdentitySessionRecordOptions {
  authSessionId?: string;
  userId?: string;
  login?: string;
  avatar?: string;
  email?: string | null;
  name?: string | null;
  githubScopes?: string[];
  encryptedToken?: EncryptedOAuthToken;
  createdAt?: number;
  expiresAt?: string;
  workspaceId?: string;
  defaultWorkspaceId?: string;
  workspaceIds?: string[];
}

export function createIdentitySessionRecord(
  options: IdentitySessionRecordOptions = {},
): IdentitySessionRecord {
  return {
    authSessionId: options.authSessionId ?? "session-1",
    userId: options.userId ?? "user-1",
    login: options.login ?? "puneet",
    avatar: options.avatar ?? "",
    email: options.email ?? "puneet@example.com",
    name: options.name ?? "Puneet Pal Singh",
    githubScopes: options.githubScopes ?? ["repo"],
    encryptedToken: options.encryptedToken ?? TEST_ENCRYPTED_OAUTH_TOKEN,
    createdAt: options.createdAt ?? Date.now(),
    expiresAt:
      options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    workspaceId: options.workspaceId,
    defaultWorkspaceId: options.defaultWorkspaceId,
    workspaceIds: options.workspaceIds,
  };
}

export function createIdentityRepository(
  seed: string | IdentitySessionRecordOptions | IdentitySessionRecord | null,
  githubScopes = ["repo"],
): IdentitySessionRepository {
  const record = toIdentitySessionRecord(seed, githubScopes);

  return {
    createGitHubSession: async () => {
      throw new Error("not used");
    },
    findSessionByHash: async () => record,
    findLatestGitHubSessionByUserId: async () => record,
    revokeSession: async () => undefined,
  };
}

function toIdentitySessionRecord(
  seed: string | IdentitySessionRecordOptions | IdentitySessionRecord | null,
  githubScopes: string[],
): IdentitySessionRecord | null {
  if (seed === null) {
    return null;
  }

  if (typeof seed === "string") {
    return createIdentitySessionRecord({ userId: seed, githubScopes });
  }

  return createIdentitySessionRecord({
    githubScopes,
    ...seed,
  });
}

/** Owned workspace records are independent of the mutable current selection. */
export function createWorkspaceRepository(
  userId: string,
  workspaceId: string,
  selectedWorkspaceId = workspaceId,
): WorkspaceRepository {
  const now = "2026-10-13T00:00:00.000Z";
  const repository = {
    id: "repo-fixture", provider: "github", owner: "acme", name: "fixture",
    fullName: "acme/fixture", repoUrl: "https://github.com/acme/fixture",
    defaultBranch: "main", providerRepoId: "fixture", createdAt: now, updatedAt: now,
  };
  const workspace = {
    id: workspaceId, userId, repoId: repository.id, name: repository.fullName,
    defaultBranch: "main", lastSelectedBranch: "main", status: "active" as const,
    createdAt: now, updatedAt: now, lastOpenedAt: now,
  };
  const selected = { ...workspace, id: selectedWorkspaceId };
  const bootstrap: WorkspaceBootstrapRecord = {
    repository, workspace: selected,
    selection: { userId, selectedWorkspaceId, selectedRepoId: repository.id, selectedBranch: "main", updatedAt: now },
  };
  return {
    selectWorkspace: async () => { throw new Error("not used"); },
    findWorkspaceSelection: async (owner) => owner === userId ? bootstrap : null,
    listWorkspaces: async (owner) => owner === userId
      ? [...new Set([workspaceId, selectedWorkspaceId])].map((id) => ({repository, workspace: {...workspace,id}, selected: id === selectedWorkspaceId})) : [],
  };
}
