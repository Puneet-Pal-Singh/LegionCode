import { describe, expect, it, vi } from "vitest";
import type { ProviderModelCacheStore } from "../stores/ProviderModelCacheStore";
import type { ProviderCredentialService } from "../ProviderCredentialService";
import type { ProviderModelCatalogPort } from "./ProviderModelCatalogPort";
import { ProviderModelDiscoveryService } from "./ProviderModelDiscoveryService";
import { ProviderModelDiscoveryAuthError } from "./errors";
import { parseModelDevCatalog } from "./ModelDevCatalog";

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

  it("enriches cached OpenAI models with catalog-declared variants", async () => {
    const store = createStoreStub();
    const now = Date.now();
    await store.setModelCache({
      providerId: "openai",
      models: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          providerId: "openai",
        },
      ],
      fetchedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      source: "provider_api",
    });
    const credentialService = {
      getApiKey: vi.fn(async () => "sk-test"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const adapter: ProviderModelCatalogPort = {
      fetchAll: vi.fn(),
      fetchPage: vi.fn(),
    };
    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openai: adapter },
      undefined,
      undefined,
      undefined,
      {
        getCatalog: vi.fn(async () =>
          parseModelDevCatalog({
            openai: {
              models: {
                "gpt-5.6-luna": {
                  reasoning: true,
                  reasoning_options: [
                    {
                      type: "effort",
                      values: ["none", "low", "medium", "high", "xhigh", "max"],
                    },
                  ],
                },
              },
            },
          }),
        ),
      },
    );

    const result = await service.getDiscoveredModels("openai", {
      view: "all",
      surface: "picker",
      limit: 50,
    });

    expect(result.models[0]?.capabilities?.reasoningEfforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(result.models[0]?.capabilityMetadata).toMatchObject({
      source: "platform_registry",
      confidence: "declared",
    });
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

  it("enriches provider-omitted card metadata from the models.dev catalog", async () => {
    const store = createStoreStub();
    const credentialService = {
      getApiKey: vi.fn(async () => "sk-test"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const adapter: ProviderModelCatalogPort = {
      fetchAll: vi.fn(async () => [
        { id: "gpt-5", name: "GPT-5", providerId: "openai" },
        { id: "gpt-4o", name: "GPT-4o", providerId: "openai" },
      ]),
      fetchPage: vi.fn(),
    };
    const modelDevCatalog = {
      getCatalog: vi.fn(async () => ({
        providers: {
          openai: {
            models: {
              "gpt-4o": {
                limit: { context: 128000, output: 16384 },
                modalities: { input: ["text", "image", "pdf"], output: ["text"] },
                reasoning: false,
                tool_call: true,
              },
              "gpt-5": {
                limit: { context: 400000, input: 272000, output: 128000 },
                modalities: { input: ["text", "image"], output: ["text"] },
                reasoning: true,
                reasoning_options: [
                  { type: "effort", values: ["minimal", "low", "medium", "high"] },
                ],
                tool_call: true,
              },
            },
          },
        },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      })),
    };

    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openai: adapter },
      undefined,
      undefined,
      undefined,
      modelDevCatalog,
    );

    const result = await service.getDiscoveredModels("openai", {
      view: "all",
      limit: 50,
    });

    const gpt4o = result.models.find((model) => model.id === "gpt-4o");
    expect(gpt4o?.contextWindow).toBe(128000);
    expect(gpt4o?.inputModalities).toEqual({ text: true, image: true, file: true });
    expect(gpt4o?.capabilities?.supportsReasoning).toBe(false);
    expect(gpt4o?.capabilities?.supportsTools).toBe(true);

    const gpt5 = result.models.find((model) => model.id === "gpt-5");
    expect(gpt5?.contextWindow).toBe(400000);
    expect(gpt5?.capabilities?.supportsReasoning).toBe(true);
    expect(gpt5?.capabilities?.reasoningEfforts).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(modelDevCatalog.getCatalog).toHaveBeenCalledTimes(1);
  });

  it("serves un-enriched models when the models.dev catalog is unavailable", async () => {
    const store = createStoreStub();
    const credentialService = {
      getApiKey: vi.fn(async () => "sk-test"),
      getConnectionConfig: vi.fn(async () => undefined),
    } as unknown as ProviderCredentialService;
    const adapter: ProviderModelCatalogPort = {
      fetchAll: vi.fn(async () => [
        { id: "gpt-4o", name: "GPT-4o", providerId: "openai" },
      ]),
      fetchPage: vi.fn(),
    };

    const service = new ProviderModelDiscoveryService(
      store as unknown as ProviderModelCacheStore,
      credentialService,
      { openai: adapter },
      undefined,
      undefined,
      undefined,
      { getCatalog: vi.fn(async () => null) },
    );

    const result = await service.getDiscoveredModels("openai", {
      view: "all",
      limit: 50,
    });

    expect(result.models[0]?.contextWindow).toBeUndefined();
    expect(result.models[0]?.capabilities).toBeUndefined();
    expect(result.models).toHaveLength(1);
  });
});
