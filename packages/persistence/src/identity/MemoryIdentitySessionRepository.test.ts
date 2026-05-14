import { describe, expect, it } from "vitest";
import { MemoryIdentitySessionRepository } from "./MemoryIdentitySessionRepository.js";

describe("MemoryIdentitySessionRepository", () => {
  it("creates stable user identity for repeated GitHub logins", async () => {
    const repository = new MemoryIdentitySessionRepository();
    const first = await repository.createGitHubSession(
      createInput("session-hash-1"),
    );
    const second = await repository.createGitHubSession(
      createInput("session-hash-2"),
    );

    expect(second.userId).toBe(first.userId);
  });

  it("finds active sessions by hash", async () => {
    const repository = new MemoryIdentitySessionRepository();
    await repository.createGitHubSession(createInput("session-hash-1"));

    await expect(
      repository.findSessionByHash("session-hash-1", "2026-05-14T00:00:00Z"),
    ).resolves.toMatchObject({
      login: "shadowbox-user",
      email: "user@example.com",
    });
  });

  it("does not return revoked sessions", async () => {
    const repository = new MemoryIdentitySessionRepository();
    await repository.createGitHubSession(createInput("session-hash-1"));
    await repository.revokeSession("session-hash-1", "2026-05-14T00:00:00Z");

    await expect(
      repository.findSessionByHash("session-hash-1", "2026-05-14T00:00:00Z"),
    ).resolves.toBeNull();
  });
});

function createInput(sessionHash: string) {
  return {
    providerAccountId: "123",
    login: "shadowbox-user",
    avatarUrl: "https://example.com/avatar.png",
    email: "user@example.com",
    displayName: "Shadowbox User",
    encryptedAccessToken: {
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
    },
    tokenFingerprint: "token-fingerprint",
    scopes: ["repo", "read:user"],
    sessionHash,
    sessionExpiresAt: "2026-05-21T00:00:00Z",
    now: "2026-05-14T00:00:00Z",
  };
}
