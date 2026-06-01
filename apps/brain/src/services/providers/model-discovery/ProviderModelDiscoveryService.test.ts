import { describe, expect, it, vi } from "vitest";
import type { ProviderModelCacheStore } from "../stores/ProviderModelCacheStore";
import type { ProviderCredentialService } from "../ProviderCredentialService";
import type { ProviderModelCatalogPort } from "./ProviderModelCatalogPort";
import { ProviderModelDiscoveryService } from "./ProviderModelDiscoveryService";
import { ProviderModelDiscoveryAuthError } from "./errors";

function createStoreStub() {
  let cache: {
    providerId: string;
    models: Array<{ id: string; name: string; providerId: string }>;
    fetchedAt: string;
    expiresAt: string;
    source: "provider_api" | "cache";
  } | null = null;
  let userCache: {
    providerId: string;
    models: Array<{ id: string; name: string; providerId: string }>;
    fetchedAt: string;
    expiresAt: string;
    source: "provider_api" | "cache";
  } | null = null;

  return {
    getModelCache: vi.fn(async () => cache),
    setModelCache: vi.fn(async (record: typeof cache) => {
      cache = record;
    }),
    invalidateModelCache: vi.fn(async () => {
      cache = null;
    }),
    getUserModelCache: vi.fn(async () => userCache),
    setUserModelCache: vi.fn(async (_key, record: typeof userCache) => {
      userCache = record;
    }),
    invalidateUserModelCache: vi.fn(async () => {
      userCache = null;
    }),
  };
}

describe("ProviderModelDiscoveryService", () => {
  it("fetches and caches openrouter models", async () => {
    const store = createStoreStub();
    const credentialService = {
      getApiKey: vi.fn(async () => "sk-or-test"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const adapter: ProviderModelCatalogPort = {
      fetchAll: vi.fn(async () => [
        { id: "openrouter/auto", name: "Auto", providerId: "openrouter" },
      ]),
      fetchPage: vi.fn(),
    };

    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openrouter: adapter },
    );

    const first = await service.getOpenRouterModels({ view: "all", limit: 50 });
    const second = await service.getOpenRouterModels({
      view: "all",
      limit: 50,
    });

    expect(first.models).toHaveLength(1);
    expect(second.models).toHaveLength(1);
    expect(adapter.fetchAll).toHaveBeenCalledTimes(1);
    expect(store.setModelCache).toHaveBeenCalledTimes(1);
  });

  it("returns stale cache when provider API fails", async () => {
    const store = createStoreStub();
    const now = Date.now();
    await store.setModelCache({
      providerId: "openrouter",
      models: [
        { id: "openrouter/auto", name: "Auto", providerId: "openrouter" },
      ],
      fetchedAt: new Date(now - 120_000).toISOString(),
      expiresAt: new Date(now - 1_000).toISOString(),
      source: "provider_api",
    });
    const credentialService = {
      getApiKey: vi.fn(async () => "sk-or-test"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const adapter: ProviderModelCatalogPort = {
      fetchAll: vi.fn(async () => {
        throw new Error("provider down");
      }),
      fetchPage: vi.fn(),
    };

    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openrouter: adapter },
    );
    const result = await service.getOpenRouterModels({
      view: "all",
      limit: 50,
    });
    expect(result.metadata.stale).toBe(true);
    expect(result.metadata.source).toBe("cache");
    expect(result.metadata.staleReason).toBe("provider_api_unavailable");
  });

  it("emits discovery observability metrics for cache-hit and stale serving", async () => {
    const store = createStoreStub();
    const now = Date.now();
    await store.setModelCache({
      providerId: "openrouter",
      models: [
        { id: "openrouter/auto", name: "Auto", providerId: "openrouter" },
      ],
      fetchedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      source: "provider_api",
    });
    const credentialService = {
      getApiKey: vi.fn(async () => "sk-or-test"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const adapter: ProviderModelCatalogPort = {
      fetchAll: vi.fn(async () => []),
      fetchPage: vi.fn(),
    };
    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openrouter: adapter },
    );

    await service.getDiscoveredModels("openrouter", { view: "all", limit: 50 });
    const metrics = service.getObservabilityMetrics();
    expect(metrics.model_discovery_cache_hits_total.openrouter).toBe(1);
    expect(
      metrics.model_discovery_requests_total.openrouter_provider_api_success,
    ).toBe(1);
  });

  it("applies launch-safe OpenRouter curation for popular model discovery", async () => {
    const store = createStoreStub();
    const credentialService = {
      getApiKey: vi.fn(async () => "sk-or-test"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const adapter = {
      fetchAll: vi.fn(async () => [
        {
          id: "openai/gpt-4.1",
          name: "GPT-4.1",
          providerId: "openrouter",
          capabilities: {
            supportsTools: true,
            supportsStructuredOutputs: true,
          },
          contextWindow: 200_000,
        },
        {
          id: "google/gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          providerId: "openrouter",
          capabilities: { supportsTools: true, supportsReasoning: true },
          contextWindow: 1_000_000,
        },
        {
          id: "random/free-model:free",
          name: "Free Random",
          providerId: "openrouter",
          capabilities: { supportsTools: false },
        },
        ...Array.from({ length: 32 }, (_, index) => ({
          id: `vendor/model-${index}`,
          name: `Model ${index}`,
          providerId: "openrouter",
          capabilities: { supportsTools: index % 2 === 0 },
          contextWindow: 8_192 + index * 1_000,
        })),
      ]),
      fetchUserModels: vi.fn(async () => [
        {
          id: "openai/gpt-4.1",
          name: "GPT-4.1",
          providerId: "openrouter",
          canonicalSlug: "gpt-4.1",
          capabilities: {
            supportsTools: true,
            supportsStructuredOutputs: true,
          },
          contextWindow: 200_000,
        },
        {
          id: "google/gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          providerId: "openrouter",
          canonicalSlug: "gemini-2.5-pro",
          capabilities: { supportsTools: true, supportsReasoning: true },
          contextWindow: 1_000_000,
        },
        {
          id: "random/free-model:free",
          name: "Free Random",
          providerId: "openrouter",
          canonicalSlug: "free-model",
          capabilities: { supportsTools: false },
        },
      ]),
      fetchProgrammingModels: vi.fn(async () => [
        {
          id: "openai/gpt-4.1",
          name: "GPT-4.1",
          providerId: "openrouter",
          canonicalSlug: "gpt-4.1",
        },
        {
          id: "google/gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          providerId: "openrouter",
          canonicalSlug: "gemini-2.5-pro",
        },
      ]),
      fetchPage: vi.fn(),
    } satisfies ProviderModelCatalogPort;

    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openrouter: adapter },
    );

    const result = await service.getDiscoveredModels("openrouter", {
      view: "popular",
      limit: 50,
    });

    expect(result.models).toHaveLength(3);
    expect(result.models[0]?.id).toBe("openrouter/auto");
    expect(result.models[1]?.id).toBe("openai/gpt-4.1");
    expect(result.models[2]?.id).toBe("google/gemini-2.5-pro");
    expect(adapter.fetchUserModels).toHaveBeenCalledTimes(1);
    expect(adapter.fetchProgrammingModels).toHaveBeenCalledTimes(1);
    expect(store.setUserModelCache).toHaveBeenCalledTimes(1);
  });

  it("maps credential decryption failures to discovery auth errors", async () => {
    const store = createStoreStub();
    const credentialService = {
      getApiKey: vi.fn(async () => {
        throw new Error("Decryption failed");
      }),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const adapter: ProviderModelCatalogPort = {
      fetchAll: vi.fn(async () => [
        { id: "openrouter/auto", name: "Auto", providerId: "openrouter" },
      ]),
      fetchPage: vi.fn(),
    };

    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openrouter: adapter },
    );

    await expect(
      service.getOpenRouterModels({ view: "all", limit: 50 }),
    ).rejects.toBeInstanceOf(ProviderModelDiscoveryAuthError);
    expect(adapter.fetchAll).not.toHaveBeenCalled();
  });

  it("filters unavailable models from picker surfaces", async () => {
    const store = createStoreStub();
    const credentialService = {
      getApiKey: vi.fn(async () => "oc-test"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const adapter: ProviderModelCatalogPort = {
      fetchAll: vi.fn(async () => [
        {
          id: "kimi-k2.6",
          name: "Kimi K2.6",
          providerId: "opencode-go",
          availability: "available",
        },
        {
          id: "qwen3.6-plus",
          name: "Qwen3.6 Plus",
          providerId: "opencode-go",
          availability: "unsupported_transport",
        },
      ]),
      fetchPage: vi.fn(),
    };

    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { "opencode-go": adapter },
    );

    const picker = await service.getDiscoveredModels("opencode-go", {
      view: "all",
      surface: "picker",
      limit: 50,
    });
    const manage = await service.getDiscoveredModels("opencode-go", {
      view: "all",
      surface: "manage",
      limit: 50,
    });

    expect(picker.models.map((model) => model.id)).toEqual(["kimi-k2.6"]);
    expect(manage.models.map((model) => model.id)).toEqual([
      "kimi-k2.6",
      "qwen3.6-plus",
    ]);
  });
});
