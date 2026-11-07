import { describe, expect, it, vi } from "vitest";
import { CloudCredentialVault } from "./CloudCredentialVault";
import type { CredentialStore } from "./stores/CredentialStore";

describe("CloudCredentialVault", () => {
  const mockCredentialStore = {
    setCredential: vi.fn().mockResolvedValue({
      credentialId: "test-cred",
      userId: "user-1",
      workspaceId: "workspace-1",
      providerId: "openai" as const,
      label: "default",
      keyFingerprint: "sk-...test",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }),
    getCredential: vi.fn().mockResolvedValue({
      credentialId: "test-cred",
      userId: "user-1",
      workspaceId: "workspace-1",
      providerId: "openai" as const,
      label: "default",
      keyFingerprint: "sk-...test",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }),
    getCredentialWithKey: vi.fn().mockResolvedValue({
      record: {
        credentialId: "test-cred",
        userId: "user-1",
        workspaceId: "workspace-1",
        providerId: "openai" as const,
        label: "default",
        keyFingerprint: "sk-...test",
        status: "connected" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
      apiKey: "sk-test-key-1234567890",
    }),
    deleteCredential: vi.fn().mockResolvedValue(undefined),
    listCredentialProviders: vi.fn().mockResolvedValue(["openai"]),
  } as unknown as CredentialStore;

  it("persists and retrieves credentials through vault contract", async () => {
    const vault = new CloudCredentialVault(mockCredentialStore, "user-1");

    await vault.setCredential("openai", "sk-test-vault-1234567890");
    expect(mockCredentialStore.setCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        apiKey: "sk-test-vault-1234567890",
      }),
    );
  });

  it("checks if provider is connected", async () => {
    const vault = new CloudCredentialVault(mockCredentialStore, "user-1");
    const isConnected = await vault.isConnected("openai");
    expect(isConnected).toBe(true);
    const credential = await mockCredentialStore.getCredential("openai");
    if (!credential) throw new Error("Missing fixture credential");
    for (const overrides of [
      { status: "revoked" as const },
      { status: "failed" as const },
      { deletedAt: new Date().toISOString() },
    ]) {
      vi.mocked(mockCredentialStore.getCredential).mockResolvedValueOnce({
        ...credential,
        ...overrides,
      });
      expect(await vault.isConnected("openai")).toBe(false);
      vi.mocked(mockCredentialStore.getCredential).mockResolvedValueOnce({
        ...credential,
        connectionConfig: { providerId: "opencode-go" },
        ...overrides,
      });
      expect(await vault.getConnectionConfig("openai")).toBeUndefined();
    }
  });

  it("gets API key for provider", async () => {
    const vault = new CloudCredentialVault(mockCredentialStore, "user-1");
    const apiKey = await vault.getApiKey("openai");
    expect(apiKey).toBe("sk-test-key-1234567890");
    const credential = await mockCredentialStore.getCredentialWithKey("openai");
    if (!credential) throw new Error("Missing fixture credential");
    for (const overrides of [
      { status: "revoked" as const },
      { status: "failed" as const },
      { deletedAt: new Date().toISOString() },
    ]) {
      vi.mocked(mockCredentialStore.getCredentialWithKey).mockResolvedValueOnce(
        {
          ...credential,
          record: { ...credential.record, ...overrides },
        },
      );
      expect(await vault.getApiKey("openai")).toBeNull();
    }
    for (const overrides of [
      { userId: "another-user" },
      { providerId: "anthropic" },
    ]) {
      vi.mocked(mockCredentialStore.getCredentialWithKey).mockResolvedValueOnce(
        {
          ...credential,
          record: { ...credential.record, ...overrides },
        },
      );
      await expect(vault.getApiKey("openai")).rejects.toThrow(
        "Credential scope does not match the authorized vault",
      );
    }
  });

  it("lists connected providers", async () => {
    const vault = new CloudCredentialVault(mockCredentialStore, "user-1");
    const providers = await vault.listConnectedProviders();
    expect(providers).toEqual(["openai"]);
    const credential = await mockCredentialStore.getCredential("openai");
    if (!credential) throw new Error("Missing fixture credential");
    vi.mocked(mockCredentialStore.getCredential).mockResolvedValueOnce({
      ...credential,
      status: "revoked",
    });
    expect(await vault.listConnectedProviders()).toEqual([]);
  });

  it("deletes credential", async () => {
    const vault = new CloudCredentialVault(mockCredentialStore, "user-1");
    await vault.deleteCredential("openai");
    expect(mockCredentialStore.deleteCredential).toHaveBeenCalledWith("openai");
  });
});
