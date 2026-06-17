import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_MODELS,
  ProviderDefinitionSchema,
  ProviderModelDefinitionSchema,
  ProviderRegistry,
  builtinProviderRegistry,
} from "./registry.js";

describe("ProviderRegistry", () => {
  it("validates every builtin provider and model", () => {
    expect(
      BUILTIN_PROVIDER_DEFINITIONS.every(
        (provider) => ProviderDefinitionSchema.safeParse(provider).success,
      ),
    ).toBe(true);
    expect(
      BUILTIN_PROVIDER_MODELS.every(
        (model) => ProviderModelDefinitionSchema.safeParse(model).success,
      ),
    ).toBe(true);
  });

  it("keeps Axis optional for custom registries", () => {
    const openai = builtinProviderRegistry.getProvider("openai");
    expect(openai).toBeDefined();
    const registry = new ProviderRegistry(openai ? [openai] : [], []);

    expect(registry.hasProvider("openai")).toBe(true);
    expect(registry.hasProvider("axis")).toBe(false);
  });

  it("exposes provider and model capabilities", () => {
    expect(builtinProviderRegistry.getProvider("openai")?.authModes).toEqual([
      "api_key",
    ]);
    expect(
      builtinProviderRegistry.getProvider("openrouter")?.modelDiscoverySupport,
    ).toBe(true);
    expect(
      builtinProviderRegistry.getProvider("local-openai-compatible")
        ?.baseUrlSupport,
    ).toBe("configurable");
    expect(
      builtinProviderRegistry.getModel("openai", "gpt-4o")?.supportsTools,
    ).toBe(true);
  });

  it("rejects duplicate providers and orphaned models", () => {
    const provider = builtinProviderRegistry.getProvider("openai");
    const model = builtinProviderRegistry.getModel("openai", "gpt-4o");
    expect(provider).toBeDefined();
    expect(model).toBeDefined();
    if (!provider || !model) {
      return;
    }

    expect(() => new ProviderRegistry([provider, provider], [])).toThrow(
      'Duplicate provider registration: "openai".',
    );
    expect(
      () =>
        new ProviderRegistry(
          [],
          [{ ...model, providerId: "missing-provider" }],
        ),
    ).toThrow("references an unregistered provider");
  });
});
