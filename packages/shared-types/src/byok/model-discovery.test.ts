import { describe, expect, it } from "vitest";
import {
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKProviderSlugSchema,
  ProviderModelRuntimeRouteSchema,
  ProviderModelTransportSchema,
} from "./model-discovery.js";

describe("BYOK model discovery contracts", () => {
  it("accepts provider slug format", () => {
    expect(BYOKProviderSlugSchema.safeParse("openrouter").success).toBe(true);
    expect(BYOKProviderSlugSchema.safeParse("google").success).toBe(true);
    expect(BYOKProviderSlugSchema.safeParse("OpenAI").success).toBe(false);
  });

  it("parses query defaults and coercions", () => {
    const parsed = BYOKDiscoveredProviderModelsQuerySchema.parse({
      limit: "25",
    });
    expect(parsed.view).toBe("popular");
    expect(parsed.limit).toBe(25);
    expect(parsed.cursor).toBeUndefined();
  });

  it("accepts paginated discovered models response", () => {
    const result = BYOKDiscoveredProviderModelsResponseSchema.safeParse({
      providerId: "openrouter",
      view: "popular",
      models: [
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          providerId: "openrouter",
          contextWindow: 128000,
          canonicalSlug: "gpt-4o",
          description: "General-purpose multimodal model",
          supportedParameters: ["tools", "reasoning"],
          outputModalities: {
            text: true,
            image: true,
          },
          capabilities: {
            supportsTools: true,
            supportsStructuredOutputs: true,
            supportsReasoning: true,
          },
          pricing: {
            inputPer1M: 5,
            outputPer1M: 15,
            currency: "USD",
          },
          runtimeRoute: {
            providerId: "openrouter",
            modelId: "openai/gpt-4o",
            transport: "openai-chat-completions",
            endpoint: "https://openrouter.ai/api/v1/chat/completions",
          },
          availability: "available",
          popularityScore: {
            score: 0.92,
            signals: {
              selectionFrequency: 0.4,
              successfulRuns: 0.3,
              providerDeclared: 0.1,
              capabilityFit: 0.07,
              costEfficiency: 0.05,
            },
          },
        },
      ],
      page: {
        limit: 50,
        hasMore: true,
        nextCursor: "cursor-2",
      },
      metadata: {
        fetchedAt: new Date().toISOString(),
        stale: false,
        source: "provider_api",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts provider model runtime route metadata", () => {
    const result = ProviderModelRuntimeRouteSchema.safeParse({
      providerId: "opencode-go",
      modelId: "kimi-k2.6",
      transport: "openai-chat-completions",
      endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown model transport values", () => {
    const result = ProviderModelTransportSchema.safeParse("magic-endpoint");

    expect(result.success).toBe(false);
  });

  it("accepts refresh response envelope", () => {
    const result = BYOKDiscoveredProviderModelsRefreshResponseSchema.safeParse({
      providerId: "google",
      refreshedAt: new Date().toISOString(),
      source: "provider_api",
      cacheInvalidated: true,
      modelsCount: 33,
    });
    expect(result.success).toBe(true);
  });
});
