import { describe, expect, it, vi } from "vitest";
import { ProviderClient, createProviderClient } from "./client.js";
import {
  ProviderClientContractError,
  ProviderClientOperationError,
} from "./errors.js";
import type { ProviderClientTransport } from "./client.js";

function createTransport(
  overrides: Partial<ProviderClientTransport> = {},
): ProviderClientTransport {
  const baseTransport: ProviderClientTransport = {
    discoverProviders: vi.fn(async () => [
      {
        providerId: "openai",
        displayName: "OpenAI",
        authModes: ["api_key"],
        capabilities: {
          streaming: true,
          tools: true,
          jsonMode: true,
          structuredOutputs: true,
        },
        adapterFamily: "openai-compatible",
        modelSource: "static",
        defaultModelId: "gpt-4o",
      },
    ]),
    discoverProviderModels: vi.fn(async () => ({
      providerId: "openai",
      view: "popular",
      models: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          providerId: "openai",
        },
      ],
      page: { limit: 50, hasMore: false },
      metadata: {
        fetchedAt: "2026-03-06T00:00:00.000Z",
        stale: false,
        source: "cache",
      },
    })),
    refreshProviderModels: vi.fn(async () => ({
      providerId: "openai",
      refreshedAt: "2026-03-06T00:00:00.000Z",
      source: "provider_api",
      cacheInvalidated: true,
      modelsCount: 1,
    })),
    listCredentials: vi.fn(async () => [
      {
        credentialId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "user-1",
        workspaceId: "workspace-1",
        providerId: "openai",
        label: "Primary",
        keyFingerprint: "sk-****1234",
        encryptedSecretJson: "{\"cipher\":\"x\"}",
        keyVersion: "v1",
        status: "connected",
        lastValidatedAt: "2026-03-06T00:00:00.000Z",
        createdAt: "2026-03-06T00:00:00.000Z",
        updatedAt: "2026-03-06T00:00:00.000Z",
        deletedAt: null,
      },
    ]),
    connectCredential: vi.fn(async () => ({
      credentialId: "550e8400-e29b-41d4-a716-446655440000",
      userId: "user-1",
      workspaceId: "workspace-1",
      providerId: "openai",
      label: "Primary",
      keyFingerprint: "sk-****1234",
      encryptedSecretJson: "{\"cipher\":\"x\"}",
      keyVersion: "v1",
      status: "connected",
      lastValidatedAt: "2026-03-06T00:00:00.000Z",
      createdAt: "2026-03-06T00:00:00.000Z",
      updatedAt: "2026-03-06T00:00:00.000Z",
      deletedAt: null,
    })),
    updateCredential: vi.fn(async () => ({
      credentialId: "550e8400-e29b-41d4-a716-446655440000",
      userId: "user-1",
      workspaceId: "workspace-1",
      providerId: "openai",
      label: "Updated",
      keyFingerprint: "sk-****1234",
      encryptedSecretJson: "{\"cipher\":\"x\"}",
      keyVersion: "v1",
      status: "connected",
      lastValidatedAt: "2026-03-06T00:00:00.000Z",
      createdAt: "2026-03-06T00:00:00.000Z",
      updatedAt: "2026-03-06T00:00:00.000Z",
      deletedAt: null,
    })),
    disconnectCredential: vi.fn(async () => undefined),
    validateCredential: vi.fn(async () => ({
      credentialId: "550e8400-e29b-41d4-a716-446655440000",
      valid: true,
      validatedAt: "2026-03-06T00:00:00.000Z",
    })),
    getPreferences: vi.fn(async () => ({
      userId: "user-1",
      workspaceId: "workspace-1",
      defaultProviderId: "openai",
      defaultModelId: "gpt-4o",
      visibleModelIds: { openai: ["gpt-4o"] },
      updatedAt: "2026-03-06T00:00:00.000Z",
    })),
    updatePreferences: vi.fn(async () => ({
      userId: "user-1",
      workspaceId: "workspace-1",
      defaultProviderId: "openai",
      defaultModelId: "gpt-4o",
      visibleModelIds: { openai: ["gpt-4o"] },
      updatedAt: "2026-03-06T00:00:00.000Z",
    })),
    resolveForRun: vi.fn(async () => ({
      providerId: "openai",
      credentialId: "550e8400-e29b-41d4-a716-446655440000",
      modelId: "gpt-4o",
      resolvedAt: "workspace_preference",
      resolvedAtTime: "2026-03-06T00:00:00.000Z",
    })),
  };

  return {
    ...baseTransport,
    ...overrides,
  };
}

describe("ProviderClient", () => {
  it("exposes a stable facade via createProviderClient", async () => {
    const transport = createTransport();
    const client = createProviderClient(transport);

    expect(client).toBeInstanceOf(ProviderClient);

    const providers = await client.discoverProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.providerId).toBe("openai");
    expect(transport.discoverProviders).toHaveBeenCalledTimes(1);
  });

  it("normalizes model query defaults before transport", async () => {
    const transport = createTransport();
    const client = new ProviderClient(transport);

    await client.discoverProviderModels("openai", {});

    expect(transport.discoverProviderModels).toHaveBeenCalledWith("openai", {
      view: "popular",
      limit: 50,
      surface: "picker",
    }, undefined);
  });

  it("fails fast on invalid request contract and skips transport", async () => {
    const transport = createTransport();
    const client = new ProviderClient(transport);

    await expect(
      client.connectCredential({
        providerId: "openai",
        secret: "",
      }),
    ).rejects.toBeInstanceOf(ProviderClientContractError);
    expect(transport.connectCredential).not.toHaveBeenCalled();
  });

  it("fails fast on invalid response contract", async () => {
    const transport = createTransport({
      discoverProviders: vi.fn(async () => [{ providerId: "" }]),
    });
    const client = new ProviderClient(transport);

    await expect(client.discoverProviders()).rejects.toBeInstanceOf(
      ProviderClientContractError,
    );
  });

  it("normalizes transport failures into typed operation errors", async () => {
    const transport = createTransport({
      resolveForRun: vi.fn(async () => {
        throw new Error("transport failed");
      }),
    });
    const client = new ProviderClient(transport);

    await expect(
      client.resolveForRun({
        providerId: "openai",
        modelId: "gpt-4o",
      }),
    ).rejects.toBeInstanceOf(ProviderClientOperationError);
  });
});
