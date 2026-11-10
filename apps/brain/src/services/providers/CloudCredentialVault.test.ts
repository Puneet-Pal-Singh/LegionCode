import { describe, expect, it, vi } from "vitest";
import { CloudCredentialVault } from "./CloudCredentialVault";
import type { CredentialStore } from "./stores/CredentialStore";

describe("CloudCredentialVault", () => {
  const mockCredentialStore = {
    setCredential: vi.fn().mockResolvedValue({
      credentialId: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
      workspaceId: "workspace-1",
      providerId: "openai" as const,
      label: "default",
      keyFingerprint: "sk-...test",
      credentialKind: "api_key" as const,
      authOwnerGeneration: 1,
      tokenMaterialVersion: 1,
      isDefault: true,
      refreshClaimId: null,
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }),
    getCredential: vi.fn().mockResolvedValue({
      credentialId: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
      workspaceId: "workspace-1",
      providerId: "openai" as const,
      label: "default",
      keyFingerprint: "sk-...test",
      credentialKind: "api_key" as const,
      authOwnerGeneration: 1,
      tokenMaterialVersion: 1,
      isDefault: true,
      refreshClaimId: null,
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }),
    getCredentialWithKey: vi.fn().mockResolvedValue({
      record: {
        credentialId: "11111111-1111-4111-8111-111111111111",
        userId: "user-1",
        workspaceId: "workspace-1",
        providerId: "openai" as const,
        label: "default",
        keyFingerprint: "sk-...test",
        credentialKind: "api_key" as const,
        authOwnerGeneration: 1,
        tokenMaterialVersion: 1,
        isDefault: true,
        refreshClaimId: null,
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
      undefined,
    );
  });

  it("checks if provider is connected", async () => {
    const vault = new CloudCredentialVault(mockCredentialStore, "user-1");
    const isConnected = await vault.isConnected("openai");
    expect(isConnected).toBe(true);
  });

  it("gets API key for provider", async () => {
    const vault = new CloudCredentialVault(mockCredentialStore, "user-1");
    const apiKey = await vault.getApiKey("openai");
    expect(apiKey).toBe("sk-test-key-1234567890");
  });

  it("lists connected providers", async () => {
    const vault = new CloudCredentialVault(mockCredentialStore, "user-1");
    const providers = await vault.listConnectedProviders();
    expect(providers).toEqual(["openai"]);
  });

  it("deletes credential", async () => {
    const vault = new CloudCredentialVault(mockCredentialStore, "user-1");
    await vault.deleteCredential("openai");
    expect(mockCredentialStore.deleteCredential).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({
        connectionId: "11111111-1111-4111-8111-111111111111",
        ownerGeneration: 1,
        tokenMaterialVersion: 1,
      }),
    );
  });
});
