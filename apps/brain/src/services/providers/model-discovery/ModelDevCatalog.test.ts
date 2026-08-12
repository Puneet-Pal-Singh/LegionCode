import { describe, expect, it, vi } from "vitest";
import type { BYOKDiscoveredProviderModel } from "@repo/shared-types";
import {
  HttpModelDevCatalogSource,
  enrichModelFromModelDev,
  parseModelDevCatalog,
} from "./ModelDevCatalog";

const MODEL_DEV_FIXTURE = {
  openai: {
    models: {
      "gpt-4o": {
        limit: { context: 128000, output: 16384 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        cost: { input: 2.5, output: 10 },
        reasoning: false,
        tool_call: true,
        temperature: true,
        structured_output: true,
      },
      "gpt-5": {
        limit: { context: 400000, input: 272000, output: 128000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 1.25, output: 10 },
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["minimal", "low", "medium", "high"] },
        ],
        tool_call: true,
        temperature: false,
        structured_output: true,
      },
    },
  },
  google: {
    models: {
      "gemini-2.5-flash": {
        limit: { context: 1048576, output: 65536 },
        modalities: {
          input: ["text", "image", "audio", "video", "pdf"],
          output: ["text"],
        },
        cost: { input: 0.3, output: 2.5 },
        reasoning: true,
        reasoning_options: [
          { type: "toggle" },
          { type: "budget_tokens", min: 0, max: 24576 },
        ],
        tool_call: true,
        temperature: true,
        structured_output: true,
      },
    },
  },
} as const;

function makeModel(overrides: Partial<BYOKDiscoveredProviderModel> = {}) {
  return {
    id: "gpt-4o",
    name: "GPT-4o",
    providerId: "openai",
    ...overrides,
  } as BYOKDiscoveredProviderModel;
}

describe("parseModelDevCatalog", () => {
  it("accepts a models.dev provider payload", () => {
    const catalog = parseModelDevCatalog(MODEL_DEV_FIXTURE, "2026-01-01T00:00:00.000Z");
    expect(catalog?.providers.openai.models["gpt-4o"].limit?.context).toBe(128000);
    expect(catalog?.fetchedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns null for an unusable payload", () => {
    expect(parseModelDevCatalog("nope")).toBeNull();
    expect(parseModelDevCatalog(null)).toBeNull();
    expect(parseModelDevCatalog({ openai: { models: "broken" } })).toBeNull();
  });

  it("keeps valid models when another upstream entry is malformed", () => {
    const catalog = parseModelDevCatalog({
      openai: {
        models: {
          "gpt-5.6-luna": MODEL_DEV_FIXTURE.openai.models["gpt-5"],
          broken: { limit: { context: "many" } },
        },
      },
    });

    expect(catalog?.providers.openai.models["gpt-5.6-luna"]).toBeDefined();
    expect(catalog?.providers.openai.models.broken).toBeUndefined();
  });

  it("accepts valid upstream zero limits and nullable effort values", () => {
    const catalog = parseModelDevCatalog({
      provider: {
        models: {
          "zero-limit": {
            limit: { context: 0, output: 0 },
            reasoning: true,
            reasoning_options: [
              { type: "effort", values: ["low", null, "high"] },
            ],
          },
        },
      },
    });

    expect(catalog?.providers.provider.models["zero-limit"]).toBeDefined();
  });
});

describe("HttpModelDevCatalogSource", () => {
  it("returns null when the fetch fails", async () => {
    const source = new HttpModelDevCatalogSource(async () => {
      throw new Error("network down");
    });
    await expect(source.getCatalog()).resolves.toBeNull();
  });

  it("returns null on non-ok response", async () => {
    const source = new HttpModelDevCatalogSource(async () => {
      throw new Error("500");
    });
    await expect(source.getCatalog()).resolves.toBeNull();
  });

  it("fetches and parses the catalog", async () => {
    const fetchJson = vi.fn(async () => MODEL_DEV_FIXTURE);
    const source = new HttpModelDevCatalogSource(fetchJson);
    const catalog = await source.getCatalog();
    expect(catalog?.providers.openai).toBeDefined();
    expect(fetchJson).toHaveBeenCalledWith("https://models.dev/api.json");
  });
});

describe("enrichModelFromModelDev", () => {
  it("fills omitted OpenAI gpt-4o metadata", () => {
    const catalog = parseModelDevCatalog(MODEL_DEV_FIXTURE)!;
    const enriched = enrichModelFromModelDev(catalog, "openai", makeModel());

    expect(enriched.contextWindow).toBe(128000);
    expect(enriched.inputModalities).toEqual({
      text: true,
      image: true,
      file: true,
    });
    expect(enriched.outputModalities).toEqual({ text: true });
    expect(enriched.capabilities?.supportsReasoning).toBe(false);
    expect(enriched.capabilities?.supportsTools).toBe(true);
    expect(enriched.capabilities?.supportsStructuredOutputs).toBe(true);
    expect(enriched.capabilities?.supportsVision).toBe(true);
    expect(enriched.pricing).toEqual({
      inputPer1M: 2.5,
      outputPer1M: 10,
      currency: "USD",
    });
    expect(enriched.capabilities?.reasoningEfforts).toBeUndefined();
    expect(enriched.capabilityMetadata).toEqual({
      source: "platform_registry",
      confidence: "declared",
      fetchedAt: catalog.fetchedAt,
    });
  });

  it("fills OpenAI gpt-5 reasoning efforts from catalog options", () => {
    const catalog = parseModelDevCatalog(MODEL_DEV_FIXTURE)!;
    const enriched = enrichModelFromModelDev(
      catalog,
      "openai",
      makeModel({ id: "gpt-5" }),
    );

    expect(enriched.contextWindow).toBe(400000);
    expect(enriched.pricing).toEqual({
      inputPer1M: 1.25,
      outputPer1M: 10,
      currency: "USD",
    });
    expect(enriched.capabilities?.supportsReasoning).toBe(true);
    expect(enriched.capabilities?.reasoningEfforts).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("fills Google gemini-2.5-flash metadata and keeps toggle-only reasoning", () => {
    const catalog = parseModelDevCatalog(MODEL_DEV_FIXTURE)!;
    const enriched = enrichModelFromModelDev(
      catalog,
      "google",
      makeModel({
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        providerId: "google",
      }),
    );

    expect(enriched.contextWindow).toBe(1048576);
    expect(enriched.inputModalities).toEqual({
      text: true,
      image: true,
      audio: true,
      video: true,
      file: true,
    });
    expect(enriched.capabilities?.supportsReasoning).toBe(true);
    expect(enriched.pricing).toEqual({
      inputPer1M: 0.3,
      outputPer1M: 2.5,
      currency: "USD",
    });
    expect(enriched.capabilities?.reasoningEfforts).toBeUndefined();
  });

  it("preserves models.dev cache and context-tier pricing", () => {
    const catalog = parseModelDevCatalog({
      openai: {
        models: {
          "gpt-5.5": {
            limit: { context: 400000 },
            cost: {
              input: 5,
              output: 30,
              cache_read: 0.5,
              cache_write: 1,
              tiers: [
                {
                  input: 10,
                  output: 45,
                  cache_read: 1,
                  cache_write: 2,
                  tier: { type: "context", size: 272000 },
                },
              ],
              context_over_200k: {
                input: 10,
                output: 45,
                cache_read: 1,
                cache_write: 2,
              },
            },
          },
        },
      },
    })!;
    const enriched = enrichModelFromModelDev(catalog, "openai", {
      id: "gpt-5.5",
      name: "GPT-5.5",
      providerId: "openai",
    });

    expect(enriched.pricing).toEqual({
      inputPer1M: 5,
      outputPer1M: 30,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 1,
      tiers: [
        {
          minimumContextTokens: 200000,
          inputPer1M: 10,
          outputPer1M: 45,
          cacheReadPer1M: 1,
          cacheWritePer1M: 2,
        },
        {
          minimumContextTokens: 272000,
          inputPer1M: 10,
          outputPer1M: 45,
          cacheReadPer1M: 1,
          cacheWritePer1M: 2,
        },
      ],
      currency: "USD",
    });
  });

  it("matches prefixed model ids against the catalog", () => {
    const catalog = parseModelDevCatalog(MODEL_DEV_FIXTURE)!;
    const enriched = enrichModelFromModelDev(
      catalog,
      "openai",
      makeModel({ id: "openai/gpt-5" }),
    );
    expect(enriched.capabilities?.reasoningEfforts).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("matches provider aliases used by the application registry", () => {
    const catalog = parseModelDevCatalog({
      togetherai: {
        models: {
          "Qwen/Qwen3.5-9B": {
            limit: { context: 32768 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    })!;
    const model = enrichModelFromModelDev(catalog, "together", {
      id: "qwen/qwen3.5-9b",
      name: "Qwen/Qwen3.5-9B",
      providerId: "together",
    });

    expect(model.contextWindow).toBe(32768);
    expect(model.inputModalities).toEqual({ text: true });
  });

  it("never overrides provider-declared fields", () => {
    const catalog = parseModelDevCatalog(MODEL_DEV_FIXTURE)!;
    const enriched = enrichModelFromModelDev(
      catalog,
      "openai",
      makeModel({
        contextWindow: 200000,
        capabilities: {
          supportsReasoning: true,
          reasoningEfforts: ["high"],
        },
        capabilityMetadata: {
          source: "provider_api",
          confidence: "declared",
        },
      }),
    );

    expect(enriched.contextWindow).toBe(200000);
    expect(enriched.capabilities?.supportsReasoning).toBe(true);
    expect(enriched.capabilities?.reasoningEfforts).toEqual(["high"]);
    expect(enriched.capabilityMetadata?.source).toBe("provider_api");
  });

  it("fills missing pricing fields from the catalog", () => {
    const catalog = parseModelDevCatalog(MODEL_DEV_FIXTURE)!;
    const enriched = enrichModelFromModelDev(
      catalog,
      "openai",
      makeModel({ pricing: { inputPer1M: 9, currency: "USD" } }),
    );

    expect(enriched.pricing).toEqual({
      inputPer1M: 9,
      outputPer1M: 10,
      currency: "USD",
    });
  });

  it("leaves unknown models untouched", () => {
    const catalog = parseModelDevCatalog(MODEL_DEV_FIXTURE)!;
    const model = makeModel({ id: "custom-model" });
    expect(enrichModelFromModelDev(catalog, "openai", model)).toBe(model);
  });

  it("does not borrow metadata from another provider with the same model id", () => {
    const catalog = parseModelDevCatalog({
      openai: { models: {} },
      "opencode-go": {
        models: {
          "gpt-5.6-luna": {
            limit: { context: 400000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    })!;
    const model = makeModel({ id: "gpt-5.6-luna" });

    expect(enrichModelFromModelDev(catalog, "openai", model)).toBe(model);
  });

  it("does not borrow lab pricing for local OpenAI-compatible endpoints", () => {
    const catalog = parseModelDevCatalog({
      openai: {
        models: {
          "gpt-4o": {
            limit: { context: 128000 },
            cost: { input: 2.5, output: 10 },
          },
        },
      },
    })!;
    const model = makeModel({
      id: "gpt-4o",
      providerId: "local-openai-compatible",
    });

    expect(
      enrichModelFromModelDev(catalog, "local-openai-compatible", model),
    ).toBe(model);
  });

  it("keeps Axis pricing platform-owned while borrowing model capabilities", () => {
    const catalog = parseModelDevCatalog({
      openrouter: {
        models: {
          "z-ai/glm-4.5-air:free": {
            limit: { context: 131072 },
            modalities: { input: ["text"], output: ["text"] },
            cost: { input: 0.1, output: 0.2 },
          },
        },
      },
    })!;
    const model = enrichModelFromModelDev(catalog, "axis", {
      id: "z-ai/glm-4.5-air:free",
      name: "z-ai/glm-4.5-air:free",
      providerId: "axis",
    });

    expect(model.contextWindow).toBe(131072);
    expect(model.pricing).toBeUndefined();
  });

  it.each([
    {
      modelId: "gpt-5.6-luna",
      npm: "@ai-sdk/openai",
      transport: "openai-responses",
      endpoint: "https://opencode.ai/zen/v1/responses",
    },
    {
      modelId: "claude-fable-5",
      npm: "@ai-sdk/anthropic",
      transport: "anthropic-messages",
      endpoint: "https://opencode.ai/zen/v1/messages",
    },
    {
      modelId: "gemini-3.5-flash",
      npm: "@ai-sdk/google",
      transport: "google-generative",
      endpoint: "https://opencode.ai/zen/v1",
    },
    {
      modelId: "glm-5.1",
      npm: "@ai-sdk/openai-compatible",
      transport: "openai-chat-completions",
      endpoint: "https://opencode.ai/zen/v1/chat/completions",
    },
  ])(
    "derives the $transport route from OpenCode's Models.dev SDK metadata",
    ({ modelId, npm, transport, endpoint }) => {
      const catalog = parseModelDevCatalog({
        opencode: {
          api: "https://opencode.ai/zen/v1",
          npm: "@ai-sdk/openai-compatible",
          models: {
            [modelId]: {
              provider: { npm },
              tool_call: true,
            },
          },
        },
      })!;

      const enriched = enrichModelFromModelDev(catalog, "opencode-zen", {
        id: modelId,
        name: modelId,
        providerId: "opencode-zen",
        availability: "unsupported_transport",
        unavailableReason: "route unresolved",
      });

      expect(enriched).toMatchObject({
        availability: "available",
        capabilities: { supportsTools: true },
        runtimeRoute: {
          providerId: "opencode-zen",
          modelId,
          transport,
          endpoint,
        },
      });
      expect(enriched.unavailableReason).toBeUndefined();
    },
  );

  it("uses the OpenCode Go provider-level API and SDK defaults", () => {
    const catalog = parseModelDevCatalog({
      "opencode-go": {
        api: "https://opencode.ai/zen/go/v1",
        npm: "@ai-sdk/openai-compatible",
        models: { "mimo-v2-omni": { tool_call: true } },
      },
    })!;

    const enriched = enrichModelFromModelDev(catalog, "opencode-go", {
      id: "mimo-v2-omni",
      name: "MiMo V2 Omni",
      providerId: "opencode-go",
      availability: "unsupported_transport",
    });

    expect(enriched.runtimeRoute).toEqual({
      providerId: "opencode-go",
      modelId: "mimo-v2-omni",
      transport: "openai-chat-completions",
      endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
    });
    expect(enriched.availability).toBe("available");
  });
});

describe("catalog-owned reasoning variants", () => {
  it("uses exactly the efforts declared by models.dev", () => {
    const catalog = parseModelDevCatalog(MODEL_DEV_FIXTURE)!;
    const base = makeModel({ id: "gpt-5" });
    const enriched = enrichModelFromModelDev(catalog, "openai", base);
    expect(enriched.capabilities?.reasoningEfforts).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});
