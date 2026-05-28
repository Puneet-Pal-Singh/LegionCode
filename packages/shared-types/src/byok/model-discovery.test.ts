import { describe, expect, it } from "vitest";
import {
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKProviderSlugSchema,
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
          inputModalities: {
            text: true,
            image: true,
          },
          outputModalities: {
            text: true,
          },
          capabilities: {
            supportsTools: true,
            supportsVision: true,
            supportsStructuredOutputs: true,
            supportsReasoning: true,
          },
          capabilityMetadata: {
            source: "provider_api",
            confidence: "confirmed",
            fetchedAt: new Date().toISOString(),
          },
          pricing: {
            inputPer1M: 5,
            outputPer1M: 15,
            currency: "USD",
          },
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

  it("distinguishes image input from image output", () => {
    const result = BYOKDiscoveredProviderModelsResponseSchema.safeParse({
      providerId: "openrouter",
      view: "all",
      models: [
        {
          id: "image-generator",
          name: "Image Generator",
          providerId: "openrouter",
          inputModalities: { text: true },
          outputModalities: { image: true },
          capabilities: { supportsVision: false },
          capabilityMetadata: {
            source: "provider_api",
            confidence: "confirmed",
          },
        },
      ],
      page: {
        limit: 50,
        hasMore: false,
      },
      metadata: {
        fetchedAt: new Date().toISOString(),
        stale: false,
        source: "provider_api",
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const [model] = result.data.models;
    expect(model).toBeDefined();
    expect(model?.inputModalities?.image).toBeUndefined();
    expect(model?.outputModalities?.image).toBe(true);
    expect(model?.capabilities?.supportsVision).toBe(false);
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
