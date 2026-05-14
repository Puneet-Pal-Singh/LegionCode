import { MemoryIdentitySessionRepository } from "@repo/persistence";
import { describe, expect, it } from "vitest";
import type { Env } from "../types/ai";
import {
  createGitHubOAuthSession,
  getAuthenticatedUserSession,
  SessionStoreUnavailableError,
} from "./AuthService";

describe("AuthService", () => {
  it("returns the authenticated session for valid opaque session cookies", async () => {
    const env = createTestEnv();
    const created = await createTestSession(env);
    const request = new Request("https://shadowbox.test", {
      headers: {
        Cookie: `shadowbox_session=${created.sessionToken}`,
      },
    });

    const result = await getAuthenticatedUserSession(request, env);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe(created.session.userId);
    expect(result?.session.login).toBe("shadowbox-user");
    expect(result?.session.githubScopes).toEqual([
      "repo",
      "read:user",
      "user:email",
    ]);
  });

  it("returns null when the session cookie is missing", async () => {
    const result = await getAuthenticatedUserSession(
      new Request("https://shadowbox.test"),
      createTestEnv(),
    );

    expect(result).toBeNull();
  });

  it("returns null for unknown session cookies", async () => {
    const request = new Request("https://shadowbox.test", {
      headers: {
        Cookie: "shadowbox_session=unknown-token",
      },
    });

    const result = await getAuthenticatedUserSession(request, createTestEnv());

    expect(result).toBeNull();
  });

  it("returns null for malformed percent-encoded session cookies", async () => {
    const request = new Request("https://shadowbox.test", {
      headers: {
        Cookie: "shadowbox_session=%E0%A4%A",
      },
    });

    const result = await getAuthenticatedUserSession(request, createTestEnv());

    expect(result).toBeNull();
  });

  it("throws a typed error when the session repository is unavailable", async () => {
    const request = new Request("https://shadowbox.test", {
      headers: {
        Cookie: "shadowbox_session=session-token",
      },
    });

    const resultPromise = getAuthenticatedUserSession(
      request,
      createFailingSessionEnv(),
    );

    await expect(resultPromise).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
  });
});

function createTestEnv(): Env {
  return {
    AUTH_IDENTITY_REPOSITORY: new MemoryIdentitySessionRepository(),
    GITHUB_TOKEN_ENCRYPTION_KEY: "test-encryption-key",
  } as unknown as Env;
}

function createFailingSessionEnv(): Env {
  return {
    AUTH_IDENTITY_REPOSITORY: {
      createGitHubSession: async () => {
        throw new Error("not used");
      },
      findSessionByHash: async () => {
        throw new Error("database unavailable");
      },
      findLatestGitHubSessionByUserId: async () => {
        throw new Error("not used");
      },
      revokeSession: async () => {
        throw new Error("not used");
      },
    },
  } as unknown as Env;
}

async function createTestSession(env: Env) {
  return await createGitHubOAuthSession(env, {
    providerAccountId: "123",
    login: "shadowbox-user",
    avatarUrl: "https://example.com/avatar.png",
    email: "user@example.com",
    displayName: "Shadowbox User",
    accessToken: "gho_test",
    encryptedToken: {
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
    },
    scopes: ["repo", "read:user", "user:email"],
    tokenExpiresInSeconds: null,
  });
}
