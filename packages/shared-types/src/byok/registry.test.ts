import { describe, it, expect } from "vitest";
import {
  ProviderRegistryEntrySchema,
  BUILTIN_PROVIDERS,
  getBuiltinRegistry,
  findBuiltinProvider,
  isKnownProvider,
  getKnownProviderIds,
  getLaunchSupportedProviders,
  getLaunchVisibleProviders,
  isLaunchSupportedProvider,
  isLaunchVisibleProvider,
  type ProviderRegistryEntry,
} from "./registry.js";

describe("Provider Registry", () => {
  it("has known builtin providers", () => {
    expect(Object.keys(BUILTIN_PROVIDERS).length).toBeGreaterThanOrEqual(3);
    expect("axis" in BUILTIN_PROVIDERS).toBe(true);
    expect("openai" in BUILTIN_PROVIDERS).toBe(true);
    expect("groq" in BUILTIN_PROVIDERS).toBe(true);
    expect("openrouter" in BUILTIN_PROVIDERS).toBe(true);
    expect("opencode-go" in BUILTIN_PROVIDERS).toBe(true);
    expect("opencode-zen" in BUILTIN_PROVIDERS).toBe(true);
    expect("cloudflare-ai" in BUILTIN_PROVIDERS).toBe(true);
  });

  it("validates provider registry entry", () => {
    const entry = BUILTIN_PROVIDERS["openai"];
    expect(entry).toBeDefined();
    if (entry) {
      const result = ProviderRegistryEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    }
  });

  it("finds builtin provider by ID", () => {
    const provider = findBuiltinProvider("openai");
    expect(provider).toBeDefined();
    if (provider) {
      expect(provider.displayName).toBe("OpenAI");
      expect(provider.capabilities.tools).toBe(true);
    }
  });

  it("recognizes known providers", () => {
    expect(isKnownProvider("axis")).toBe(true);
    expect(isKnownProvider("openai")).toBe(true);
    expect(isKnownProvider("groq")).toBe(true);
    expect(isKnownProvider("unknown-provider")).toBe(false);
  });

  it("returns all known provider IDs", () => {
    const ids = getKnownProviderIds();
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids).toContain("axis");
    expect(ids).toContain("openai");
    expect(ids).toContain("groq");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("opencode-go");
    expect(ids).toContain("opencode-zen");
    expect(ids).toContain("cloudflare-ai");
  });

  it("generates registry with timestamp", () => {
    const registry = getBuiltinRegistry();
    expect(registry.providers.length).toBeGreaterThanOrEqual(3);
    expect(registry.generatedAt).toBeDefined();
    // Validate it's a valid ISO datetime
    expect(new Date(registry.generatedAt).getTime()).toBeGreaterThan(0);
  });
});

describe("Provider Capabilities", () => {
  it("openai has all capabilities", () => {
    const openai = BUILTIN_PROVIDERS["openai"];
    expect(openai).toBeDefined();
    if (openai) {
      expect(openai.capabilities.streaming).toBe(true);
      expect(openai.capabilities.tools).toBe(true);
      expect(openai.capabilities.jsonMode).toBe(true);
      expect(openai.capabilities.structuredOutputs).toBe(true);
    }
  });

  it("groq has limited capabilities", () => {
    const groq = BUILTIN_PROVIDERS["groq"];
    expect(groq).toBeDefined();
    if (groq) {
      expect(groq.capabilities.streaming).toBe(true);
      expect(groq.capabilities.tools).toBe(true);
      expect(groq.capabilities.jsonMode).toBe(false);
      expect(groq.capabilities.structuredOutputs).toBe(false);
    }
  });

  it("openrouter supports remote model source", () => {
    const openrouter = BUILTIN_PROVIDERS["openrouter"];
    expect(openrouter).toBeDefined();
    if (openrouter) {
      expect(openrouter.modelSource).toBe("remote");
    }
  });

  it("axis uses platform managed auth mode", () => {
    const axis = BUILTIN_PROVIDERS["axis"];
    expect(axis).toBeDefined();
    if (axis) {
      expect(axis.authModes).toEqual(["platform_managed"]);
      expect(axis.defaultModelId).toBe("z-ai/glm-4.5-air:free");
    }
  });

  it("marks hidden and launch-ready providers truthfully", () => {
    expect(BUILTIN_PROVIDERS.google?.launchStage).toBe("supported");
    expect(BUILTIN_PROVIDERS.cohere?.launchStage).toBe("hidden");
    expect(BUILTIN_PROVIDERS.mistral?.launchStage).toBe("hidden");
    expect(BUILTIN_PROVIDERS.together?.launchStage).toBe("supported");
    expect(BUILTIN_PROVIDERS.cerebras?.launchStage).toBe("supported");
    expect(BUILTIN_PROVIDERS["opencode-go"]?.launchStage).toBe("supported");
    expect(BUILTIN_PROVIDERS["opencode-zen"]?.launchStage).toBe("supported");
    expect(BUILTIN_PROVIDERS["cloudflare-ai"]?.launchStage).toBe("coming_soon");
  });

  it("registers OpenCode and Cloudflare providers with truthful runtime families", () => {
    expect(BUILTIN_PROVIDERS["opencode-go"]?.adapterFamily).toBe(
      "openai-compatible",
    );
    expect(BUILTIN_PROVIDERS["opencode-go"]?.modelsEndpoint).toBe(
      "https://opencode.ai/zen/go/v1/models",
    );
    expect(BUILTIN_PROVIDERS["opencode-zen"]?.adapterFamily).toBe(
      "custom-http",
    );
    expect(BUILTIN_PROVIDERS["opencode-zen"]?.modelsEndpoint).toBe(
      "https://opencode.ai/zen/v1/models",
    );
    expect(BUILTIN_PROVIDERS["cloudflare-ai"]?.adapterFamily).toBe(
      "custom-http",
    );
  });
});

describe("Provider launch visibility", () => {
  it("returns only launch-visible providers from the builtin registry", () => {
    const visibleProviderIds = getLaunchVisibleProviders().map(
      (entry) => entry.providerId,
    );

    expect(visibleProviderIds).toContain("openai");
    expect(visibleProviderIds).toContain("anthropic");
    expect(visibleProviderIds).toContain("google");
    expect(visibleProviderIds).toContain("together");
    expect(visibleProviderIds).toContain("cerebras");
    expect(visibleProviderIds).toContain("opencode-go");
    expect(visibleProviderIds).toContain("opencode-zen");
    expect(visibleProviderIds).toContain("cloudflare-ai");
    expect(visibleProviderIds).not.toContain("mistral");
    expect(visibleProviderIds).not.toContain("cohere");
  });

  it("returns only launch-supported providers from the builtin registry", () => {
    const supportedProviderIds = getLaunchSupportedProviders().map(
      (entry) => entry.providerId,
    );

    expect(supportedProviderIds).toContain("groq");
    expect(supportedProviderIds).toContain("google");
    expect(supportedProviderIds).toContain("together");
    expect(supportedProviderIds).toContain("cerebras");
    expect(supportedProviderIds).toContain("opencode-go");
    expect(supportedProviderIds).toContain("opencode-zen");
    expect(supportedProviderIds).not.toContain("cloudflare-ai");
    expect(supportedProviderIds).not.toContain("mistral");
    expect(supportedProviderIds).not.toContain("cohere");
  });

  it("treats missing launch stage as hidden for raw object literals", () => {
    const rawEntry: ProviderRegistryEntry = {
      providerId: "test-provider",
      displayName: "Test Provider",
      authModes: ["api_key"],
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: true,
        structuredOutputs: true,
      },
      adapterFamily: "openai-compatible" as const,
      modelSource: "static" as const,
    };

    expect(isLaunchVisibleProvider(rawEntry)).toBe(false);
    expect(isLaunchSupportedProvider(rawEntry)).toBe(false);
  });
});
