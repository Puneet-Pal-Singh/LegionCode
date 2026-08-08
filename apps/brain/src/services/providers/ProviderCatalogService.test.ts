import { describe, expect, it, vi } from "vitest";
import { ProviderCatalogService } from "./ProviderCatalogService";
import { ProviderRegistryService } from "./ProviderRegistryService";
import { ProviderModelDiscoveryApiError } from "./model-discovery/errors";

function createDiscoveryStub() {
  return {
    getDiscoveredModels: vi.fn(),
    refreshDiscoveredModels: vi.fn(),
    enrichModels: vi.fn(),
  };
}

describe("ProviderCatalogService", () => {
  it("builds startup catalog from registry metadata without remote discovery", async () => {
    const discovery = createDiscoveryStub();
    const service = new ProviderCatalogService(
      new ProviderRegistryService(),
      discovery as never,
    );

    const catalog = await service.getCatalog();
    const google = catalog.providers.find(
      (provider) => provider.providerId === "google",
    );

    expect(catalog.providers.map((provider) => provider.providerId)).toContain(
      "google",
    );
    expect(google?.models).toEqual([]);
    expect(google?.defaultModelId).toBe("gemini-2.5-flash-lite");
    expect(discovery.getDiscoveredModels).not.toHaveBeenCalled();
  });

  it("isolates visibility failures to the affected provider", async () => {
    const discovery = createDiscoveryStub();
    const service = new ProviderCatalogService(
      new ProviderRegistryService(),
      discovery as never,
      async (provider) => provider.providerId !== "axis",
    );

    const catalog = await service.getCatalog();

    expect(
      catalog.providers.map((provider) => provider.providerId),
    ).not.toContain("axis");
    expect(catalog.providers.map((provider) => provider.providerId)).toContain(
      "google",
    );
  });

  it("serves the complete OpenAI provider inventory through remote discovery", async () => {
    const discovery = createDiscoveryStub();
    discovery.getDiscoveredModels.mockResolvedValue({
      providerId: "openai",
      view: "popular",
      models: [
        { id: "gpt-5.2", name: "GPT-5.2", providerId: "openai" },
        { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", providerId: "openai" },
      ],
      page: { limit: 50, hasMore: false },
      metadata: {
        fetchedAt: new Date().toISOString(),
        stale: false,
        source: "provider_api",
        status: "available",
      },
    });
    const service = new ProviderCatalogService(
      new ProviderRegistryService(),
      discovery as never,
    );

    const response = await service.getDiscoveredModels("openai", {
      view: "popular",
      surface: "picker",
      limit: 50,
    });

    expect(response.metadata).toMatchObject({
      source: "provider_api",
      status: "available",
      stale: false,
    });
    expect(response.models.map((model) => model.id)).toEqual([
      "gpt-5.2",
      "gpt-5.2-codex",
    ]);
    expect(discovery.getDiscoveredModels).toHaveBeenCalledWith("openai", {
      view: "popular",
      surface: "picker",
      limit: 50,
    });
  });

  it("enriches static provider cards through the canonical metadata owner", async () => {
    const discovery = createDiscoveryStub();
    discovery.enrichModels.mockImplementation(async (_providerId, models) =>
      models.map((model: Record<string, unknown>) => ({
        ...model,
        contextWindow: 200000,
        inputModalities: { text: true, image: true },
        capabilities: {
          supportsReasoning: true,
          supportsTools: true,
        },
      })),
    );
    const service = new ProviderCatalogService(
      new ProviderRegistryService(),
      discovery as never,
    );

    const response = await service.getDiscoveredModels("anthropic", {
      view: "all",
      surface: "picker",
      limit: 50,
    });

    expect(response.models[0]).toMatchObject({
      id: "claude-3-opus",
      contextWindow: 200000,
      inputModalities: { text: true, image: true },
      capabilities: { supportsReasoning: true, supportsTools: true },
    });
    expect(discovery.enrichModels).toHaveBeenCalledWith(
      "anthropic",
      expect.arrayContaining([
        expect.objectContaining({ id: "claude-3-opus" }),
      ]),
    );
  });

  it("returns stale cache metadata when selected-provider discovery is cached", async () => {
    const discovery = createDiscoveryStub();
    discovery.getDiscoveredModels.mockResolvedValue({
      providerId: "google",
      view: "popular",
      models: [
        { id: "gemini-2.5-flash", name: "Gemini", providerId: "google" },
      ],
      page: { limit: 50, hasMore: false },
      metadata: {
        fetchedAt: new Date().toISOString(),
        stale: true,
        source: "cache",
        staleReason: "provider_api_unavailable",
        status: "available",
      },
    });
    const service = new ProviderCatalogService(
      new ProviderRegistryService(),
      discovery as never,
    );

    const response = await service.getDiscoveredModels("google", {
      view: "popular",
      surface: "picker",
      limit: 50,
    });

    expect(response.models).toHaveLength(1);
    expect(response.metadata).toMatchObject({
      source: "cache",
      stale: true,
      status: "available",
    });
  });

  it("does not preempt the discovery adapter's network deadline", async () => {
    vi.useFakeTimers();
    try {
      const discovery = createDiscoveryStub();
      discovery.getDiscoveredModels.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  providerId: "google",
                  view: "popular",
                  models: [
                    {
                      id: "gemini-2.5-flash",
                      name: "Gemini 2.5 Flash",
                      providerId: "google",
                    },
                  ],
                  page: { limit: 50, hasMore: false },
                  metadata: {
                    fetchedAt: new Date().toISOString(),
                    stale: false,
                    source: "provider_api",
                    status: "available",
                  },
                }),
              5_100,
            );
          }),
      );
      const service = new ProviderCatalogService(
        new ProviderRegistryService(),
        discovery as never,
      );

      const request = service.getDiscoveredModels("google", {
        view: "popular",
        surface: "picker",
        limit: 50,
      });
      await vi.advanceTimersByTimeAsync(5_100);
      const response = await request;

      expect(response).toMatchObject({
        providerId: "google",
        models: [{ id: "gemini-2.5-flash" }],
        metadata: {
          status: "available",
          stale: false,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn a provider API failure into an invented model", async () => {
    const discovery = createDiscoveryStub();
    discovery.getDiscoveredModels.mockRejectedValue(
      new ProviderModelDiscoveryApiError("provider unavailable", {
        status: 504,
      }),
    );
    const service = new ProviderCatalogService(
      new ProviderRegistryService(),
      discovery as never,
    );

    const response = await service.getDiscoveredModels("google", {
      view: "popular",
      surface: "picker",
      limit: 50,
    });

    expect(response.models).toEqual([]);
    expect(response.metadata.status).toBe("unavailable");
    expect(response.metadata.statusReason).toBe("timeout");
  });

  it("lets explicit refresh use the discovery adapter's network deadline", async () => {
    vi.useFakeTimers();
    try {
      const discovery = createDiscoveryStub();
      discovery.refreshDiscoveredModels.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  providerId: "google",
                  refreshedAt: new Date().toISOString(),
                  source: "provider_api",
                  cacheInvalidated: true,
                  modelsCount: 3,
                }),
              5_100,
            );
          }),
      );
      const service = new ProviderCatalogService(
        new ProviderRegistryService(),
        discovery as never,
      );

      const refresh = service.refreshDiscoveredModels("google");
      await vi.advanceTimersByTimeAsync(5_100);

      await expect(refresh).resolves.toMatchObject({
        providerId: "google",
        modelsCount: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
