import { describe, expect, it, vi } from "vitest";
import {
  BYOKDiscoveredProviderModelsResponseSchema,
  type ProviderId,
} from "@repo/shared-types";
import type { ProviderModelCacheStore } from "../stores/ProviderModelCacheStore";
import type { ProviderCredentialService } from "../ProviderCredentialService";
import type { ProviderModelCatalogPort } from "./ProviderModelCatalogPort";
import { ProviderModelDiscoveryService } from "./ProviderModelDiscoveryService";

function createStoreStub() {
  let cache: {
    providerId: ProviderId;
    models: Array<{ id: string; name: string; providerId: string }>;
    fetchedAt: string;
    expiresAt: string;
    source: "provider_api" | "cache";
  } | null = null;

  return {
    getScopeSnapshot: () => ({ userId: "user-1", workspaceId: "ws-1" }),
    getModelCache: vi.fn(async () => cache),
    setModelCache: vi.fn(async (record: typeof cache) => {
      cache = record;
    }),
    invalidateModelCache: vi.fn(async () => {
      cache = null;
    }),
  };
}

function createAdapter(providerId: ProviderId): ProviderModelCatalogPort {
  return {
    fetchAll: vi.fn(async () => [
      {
        id: `${providerId}/model-1`,
        name: `${providerId} model 1`,
        providerId,
      },
      {
        id: `${providerId}/model-2`,
        name: `${providerId} model 2`,
        providerId,
      },
    ]),
    fetchPage: vi.fn(),
  };
}

describe("ProviderModelDiscovery Conformance", () => {
  it("maintains response schema parity for openrouter and google", async () => {
    const store = createStoreStub();
    const credentialService = {
      getApiKey: vi.fn(async () => "api-key"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      {
        openrouter: createAdapter("openrouter"),
        google: createAdapter("google"),
      },
    );

    const [openrouter, google] = await Promise.all([
      service.getDiscoveredModels("openrouter", { view: "all", limit: 2 }),
      service.getDiscoveredModels("google", { view: "all", limit: 2 }),
    ]);

    expect(
      BYOKDiscoveredProviderModelsResponseSchema.parse(openrouter),
    ).toBeDefined();
    expect(
      BYOKDiscoveredProviderModelsResponseSchema.parse(google),
    ).toBeDefined();
    expect(Object.keys(openrouter.page).sort()).toEqual(
      Object.keys(google.page).sort(),
    );
    expect(Object.keys(openrouter.metadata).sort()).toEqual(
      Object.keys(google.metadata).sort(),
    );
  });

  it("returns typed auth errors when provider credentials are missing", async () => {
    const store = createStoreStub();
    const credentialService = {
      getApiKey: vi.fn(async () => null),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openrouter: createAdapter("openrouter") },
    );

    await expect(
      service.getDiscoveredModels("openrouter", { view: "all", limit: 10 }),
    ).rejects.toMatchObject({
      code: "MODEL_DISCOVERY_AUTH_FAILED",
      status: 401,
    });
  });

  it("returns typed cache errors when cache read fails", async () => {
    const store = createStoreStub();
    store.getModelCache.mockRejectedValueOnce(new Error("cache down"));
    const credentialService = {
      getApiKey: vi.fn(async () => "api-key"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openrouter: createAdapter("openrouter") },
    );

    await expect(
      service.getDiscoveredModels("openrouter", { view: "all", limit: 10 }),
    ).rejects.toMatchObject({
      code: "MODEL_DISCOVERY_CACHE_FAILED",
      status: 503,
    });
  });

  it("fails fast with typed API error for invalid cursor", async () => {
    const store = createStoreStub();
    const credentialService = {
      getApiKey: vi.fn(async () => "api-key"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openrouter: createAdapter("openrouter") },
    );

    await expect(
      service.getDiscoveredModels("openrouter", {
        view: "all",
        limit: 10,
        cursor: "bad-cursor",
      }),
    ).rejects.toMatchObject({
      code: "MODEL_DISCOVERY_PROVIDER_API_FAILED",
      status: 400,
      retryable: false,
    });
  });
});
