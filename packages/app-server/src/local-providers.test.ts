import { describe, expect, it } from "vitest";

import { getBuiltinRegistry, builtinProviderRegistry } from "@repo/provider-core";
import { LocalProviderService, type ProviderSelection } from "./local-providers.js";

describe("LocalProviderService", () => {
  it("uses supported API-key registry entries and returns registry-sourced model data", () => {
    const { service } = createService();
    const expected = getBuiltinRegistry().providers.filter((provider) =>
      provider.launchStage === "supported" && provider.authModes.includes("api_key"),
    );
    expect(service.listCatalog()).toEqual(expected);

    for (const provider of expected) {
      const response = service.listModels(provider.providerId);
      expect(response.providerId).toBe(provider.providerId);
      expect(response.metadata).toMatchObject({ source: "registry", stale: false, status: "available" });
      expect(response.models.map(({ id }) => id)).toEqual(
        builtinProviderRegistry.listModels(provider.providerId).map(({ modelId }) => modelId),
      );
      if (response.models.length === 0) {
        expect(response.page).toEqual({ limit: 1, hasMore: false });
      }
    }
  });

  it("selects a registered non-OpenAI model only with matching trusted credential configuration", async () => {
    const { service, current } = createService();
    const provider = service.listCatalog().find((entry) => entry.providerId !== "openai"
      && builtinProviderRegistry.listModels(entry.providerId).length > 0);
    if (!provider) throw new Error("Provider registry has no non-OpenAI API-key model");
    const modelId = builtinProviderRegistry.listModels(provider.providerId)[0]!.modelId;

    await expect(service.select({ providerId: provider.providerId, modelId }, undefined)).rejects.toThrow();
    await expect(service.select({ providerId: provider.providerId, modelId }, {
      providerId: "openai",
      status: "present",
    })).rejects.toThrow();
    await expect(service.select({ providerId: provider.providerId, modelId: "unregistered-model" }, {
      providerId: provider.providerId,
      status: "present",
    })).rejects.toThrow();
    await expect(service.select({ providerId: "cohere", modelId }, {
      providerId: "cohere",
      status: "present",
    })).rejects.toThrow();
    expect(current()).toBeNull();

    await expect(service.select({ providerId: provider.providerId, modelId }, {
      providerId: provider.providerId,
      status: "present",
    })).resolves.toEqual({ providerId: provider.providerId, modelId });
    expect(JSON.stringify(current())).not.toContain("secret");
  });
});

function createService() {
  let saved: ProviderSelection | null = null;
  const service = new LocalProviderService({
    selectionStore: {
      read: async () => saved,
      write: async (selection) => { saved = selection; },
      clear: async () => { saved = null; },
    },
  });
  return { service, current: () => saved };
}
