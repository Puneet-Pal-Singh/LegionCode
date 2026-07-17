import { describe, expect, it, vi } from "vitest";
import { ProviderCatalogService } from "./ProviderCatalogService";
import { ProviderRegistryService } from "./ProviderRegistryService";
import { ProviderModelDiscoveryApiError } from "./model-discovery/errors";

function createDiscoveryStub() {
  return {
    getDiscoveredModels: vi.fn(),
    refreshDiscoveredModels: vi.fn(),
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

  it("serves static provider defaults from the registry without a provider call", async () => {
    const discovery = createDiscoveryStub();
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
      source: "registry",
      status: "available",
      stale: false,
    });
    expect(response.models.map((model) => model.id)).toEqual(["gpt-4o"]);
    expect(discovery.getDiscoveredModels).not.toHaveBeenCalled();
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

  it("returns a typed unavailable state after the bounded selected-provider timeout", async () => {
    vi.useFakeTimers();
    try {
      const discovery = createDiscoveryStub();
      discovery.getDiscoveredModels.mockReturnValue(new Promise(() => {}));
      const service = new ProviderCatalogService(
        new ProviderRegistryService(),
        discovery as never,
      );

      const request = service.getDiscoveredModels("google", {
        view: "popular",
        surface: "picker",
        limit: 50,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const response = await request;

      expect(response).toMatchObject({
        providerId: "google",
        models: [],
        metadata: {
          status: "unavailable",
          statusReason: "timeout",
          stale: true,
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
});
