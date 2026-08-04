import { describe, expect, it, vi } from "vitest";
import type { BYOKDiscoveredProviderModel } from "@repo/shared-types";
import {
  HttpModelDevCatalogSource,
  enrichModelFromModelDev,
  parseModelDevCatalog,
} from "./ModelDevCatalog";
import { enrichProviderReasoningVariants } from "./ProviderReasoningVariants";

const MODEL_DEV_FIXTURE = {
  openai: {
    models: {
      "gpt-4o": {
        limit: { context: 128000, output: 16384 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        reasoning: false,
        tool_call: true,
        temperature: true,
        structured_output: true,
      },
      "gpt-5": {
        limit: { context: 400000, input: 272000, output: 128000 },
        modalities: { input: ["text", "image"], output: ["text"] },
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
    expect(enriched.capabilities?.reasoningEfforts).toBeUndefined();
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
});

describe("enrichment with reasoning variants", () => {
  it("catalog efforts win over the regex variant fallback", () => {
    const catalog = parseModelDevCatalog(MODEL_DEV_FIXTURE)!;
    const base = makeModel({ id: "gpt-5" });
    const enriched = enrichProviderReasoningVariants(
      "openai",
      enrichModelFromModelDev(catalog, "openai", base),
    );
    expect(enriched.capabilities?.reasoningEfforts).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});
