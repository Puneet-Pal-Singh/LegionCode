import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterModelCatalogAdapter } from "./OpenRouterModelCatalogAdapter";

describe("OpenRouterModelCatalogAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes OpenRouter model payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "openai/gpt-4o",
              name: "GPT-4o",
              context_length: 128000,
              pricing: {
                prompt: "0.000005",
                completion: "0.000015",
              },
              supported_parameters: ["tools"],
              slug: "gpt-4o",
              description: "General-purpose multimodal model",
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              settings: {
                structured_outputs: true,
                reasoning: true,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenRouterModelCatalogAdapter();
    const models = await adapter.fetchAll("openrouter", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "sk-or-test",
    });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("openai/gpt-4o");
    expect(models[0].providerId).toBe("openrouter");
    expect(models[0].canonicalSlug).toBe("gpt-4o");
    expect(models[0].capabilities?.supportsTools).toBe(true);
    expect(models[0].capabilities?.supportsVision).toBe(true);
    expect(models[0].capabilities?.supportsStructuredOutputs).toBe(true);
    expect(models[0].capabilities?.supportsReasoning).toBe(true);
    expect(models[0].inputModalities?.text).toBe(true);
    expect(models[0].inputModalities?.image).toBe(true);
    expect(models[0].outputModalities?.text).toBe(true);
    expect(models[0].outputModalities?.image).toBe(false);
    expect(models[0].capabilityMetadata).toMatchObject({
      source: "provider_api",
      confidence: "confirmed",
    });
    expect(models[0].capabilityMetadata?.fetchedAt).toEqual(expect.any(String));
  });

  it("does not infer image input from image output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "openai/image-model",
              name: "Image Model",
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["image"],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenRouterModelCatalogAdapter();
    const models = await adapter.fetchAll("openrouter", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "sk-or-test",
    });

    expect(models[0].inputModalities?.image).toBe(false);
    expect(models[0].outputModalities?.image).toBe(true);
    expect(models[0].capabilities?.supportsVision).toBe(false);
  });

  it("uses legacy modality only as declared capability metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "openai/legacy-vision",
              architecture: { modality: ["text", "image"] },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenRouterModelCatalogAdapter();
    const models = await adapter.fetchAll("openrouter", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "sk-or-test",
    });

    expect(models[0].inputModalities?.image).toBe(true);
    expect(models[0].outputModalities).toBeUndefined();
    expect(models[0].capabilities?.supportsVision).toBe(true);
    expect(models[0].capabilityMetadata).toMatchObject({
      source: "provider_api",
      confidence: "declared",
    });
    expect(models[0].capabilityMetadata?.fetchedAt).toEqual(expect.any(String));
  });

  it("fails fast on provider API failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );

    const adapter = new OpenRouterModelCatalogAdapter();
    await expect(
      adapter.fetchAll("openrouter", {
        userId: "user-1",
        workspaceId: "ws-1",
        apiKey: "sk-or-test",
      }),
    ).rejects.toThrow("OpenRouter models request failed");
  });

  it("wraps network errors as typed discovery errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const adapter = new OpenRouterModelCatalogAdapter();

    await expect(
      adapter.fetchAll("openrouter", {
        userId: "user-1",
        workspaceId: "ws-1",
        apiKey: "sk-or-test",
      }),
    ).rejects.toThrow("network error");
  });

  it("rejects invalid pagination cursor values", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "openai/gpt-4o" }],
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenRouterModelCatalogAdapter();

    await expect(
      adapter.fetchPage({
        providerId: "openrouter",
        credentialContext: {
          userId: "user-1",
          workspaceId: "ws-1",
          apiKey: "sk-or-test",
        },
        limit: 10,
        cursor: "bad-cursor",
      }),
    ).rejects.toThrow("Invalid OpenRouter pagination cursor");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
