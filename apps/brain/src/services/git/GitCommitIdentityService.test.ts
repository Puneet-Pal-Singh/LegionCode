import { describe, expect, it } from "vitest";
import type { Env } from "../../types/ai";
import {
  CommitIdentityError,
  readCommitIdentityStateForUser,
  resolveCommitIdentityForCommit,
  resolveCommitIdentityForStoredOAuthSession,
  resolveCommitIdentityForStoredUserSession,
} from "./GitCommitIdentityService";
import { createIdentityRepository } from "../../test-utils/identityTestHelpers";

describe("GitCommitIdentityService", () => {
  it("returns null when the stored user session is malformed", async () => {
    const result = await resolveCommitIdentityForStoredUserSession(
      {
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository(null),
      } as unknown as Env,
      "user-1",
    );

    expect(result).toBeNull();
  });

  it("resolves identity state from hydrated session data", async () => {
    const state = await readCommitIdentityStateForUser(
      {} as unknown as Env,
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
        {} as unknown as Env,
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

  it("resolves runtime commit identity from OAuth session", async () => {
    const identity = await resolveCommitIdentityForStoredOAuthSession(
      {
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository({
          userId: "user-1",
          login: "puneet",
          avatar: "",
          email: "puneet@example.com",
          name: "Puneet Pal Singh",
        }),
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
