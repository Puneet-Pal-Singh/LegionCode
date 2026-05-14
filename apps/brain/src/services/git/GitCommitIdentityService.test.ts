import { describe, expect, it } from "vitest";
import type { Env } from "../../types/ai";
import {
  CommitIdentityError,
  readCommitIdentityStateForUser,
  resolveCommitIdentityForCommit,
  resolveCommitIdentityForStoredOAuthSession,
  resolveCommitIdentityForStoredUserSession,
} from "./GitCommitIdentityService";

describe("GitCommitIdentityService", () => {
  it("returns null when the stored user session is malformed", async () => {
    const result = await resolveCommitIdentityForStoredUserSession(
      {
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository(null),
        SESSIONS: {
          get: async () => "{bad json",
        },
      } as unknown as Env,
      "user-1",
    );

    expect(result).toBeNull();
  });

  it("ignores malformed persisted identity preferences and falls back to hydrated session data", async () => {
    const state = await readCommitIdentityStateForUser(
      {
        SESSIONS: {
          get: async () => "{bad json",
        },
      } as unknown as Env,
      {
        userId: "user-1",
        session: {
          userId: "user-1",
          login: "puneet",
          avatar: "",
          email: "puneet@example.com",
          name: "Puneet Pal Singh",
          encryptedToken: "encrypted-token",
          createdAt: Date.now(),
        },
      },
    );

    expect(state).toEqual({
      state: "ready",
      identity: {
        authorName: "Puneet Pal Singh",
        authorEmail: "puneet@example.com",
        source: "github_profile",
        verified: true,
      },
    });
  });

  it("rejects explicit commit identities that omit the author name", async () => {
    await expect(
      resolveCommitIdentityForCommit(
        {
          SESSIONS: {
            put: async () => undefined,
          },
        } as unknown as Env,
        null,
        {
          authorName: "   ",
          authorEmail: "puneet@example.com",
        },
      ),
    ).rejects.toMatchObject<Partial<CommitIdentityError>>({
      code: "COMMIT_IDENTITY_INCOMPLETE",
      metadata: {
        commitIdentity: {
          state: "requires_input",
          reason: "missing_name",
        },
      },
    });
  });

  it("resolves runtime commit identity from OAuth session even when a persisted preference exists", async () => {
    const identity = await resolveCommitIdentityForStoredOAuthSession(
      {
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository({
          userId: "user-1",
          login: "puneet",
          avatar: "",
          email: "puneet@example.com",
          name: "Puneet Pal Singh",
        }),
        SESSIONS: {
          get: async (key: string) => {
            if (key === "git_commit_identity_preference:user-1") {
              return JSON.stringify({
                authorName: "Random User",
                authorEmail: "random@example.com",
                verified: false,
                updatedAt: Date.now(),
              });
            }
            return null;
          },
        },
      } as unknown as Env,
      "user-1",
    );

    expect(identity).toEqual({
      authorName: "Puneet Pal Singh",
      authorEmail: "puneet@example.com",
      source: "github_profile",
      verified: true,
    });
  });
});

function createIdentityRepository(
  session: {
    userId: string;
    login: string;
    avatar: string;
    email: string | null;
    name: string | null;
  } | null,
) {
  const record = session
    ? {
        authSessionId: "session-1",
        userId: session.userId,
        login: session.login,
        avatar: session.avatar,
        email: session.email,
        name: session.name,
        githubScopes: ["repo"],
        encryptedToken: {
          ciphertext: "ciphertext",
          iv: "iv",
          tag: "tag",
        },
        createdAt: Date.now(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
    : null;

  return {
    createGitHubSession: async () => {
      throw new Error("not used");
    },
    findSessionByHash: async () => record,
    findLatestGitHubSessionByUserId: async () => record,
    revokeSession: async () => undefined,
  };
}
