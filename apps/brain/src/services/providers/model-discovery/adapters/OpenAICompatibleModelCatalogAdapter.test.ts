import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelCatalogAdapter } from "./OpenAICompatibleModelCatalogAdapter";
import { ProviderModelDiscoveryApiError } from "../errors";

describe("OpenAICompatibleModelCatalogAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes OpenAI-compatible model response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenAICompatibleModelCatalogAdapter(
      "openai",
      "https://api.openai.com/v1",
    );
    const models = await adapter.fetchAll("openai", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "sk-test",
    });

    expect(models).toHaveLength(2);
    expect(models[0].providerId).toBe("openai");
    expect(models[0].id).toBe("gpt-4o");
  });

  it("does not invent reasoning efforts absent from provider metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "gpt-5.6-luna" }, { id: "gpt-5-pro" }],
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatibleModelCatalogAdapter(
      "openai",
      "https://api.openai.com/v1",
    );

    const models = await adapter.fetchAll("openai", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "sk-test",
    });

    expect(models[0]?.capabilities).toBeUndefined();
    expect(models[1]?.capabilities).toBeUndefined();
  });

  it("uses reasoning efforts explicitly returned by the provider", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "provider-reasoning-model",
              reasoning_efforts: ["light", "medium", "high", "medium"],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatibleModelCatalogAdapter(
      "openai",
      "https://api.openai.com/v1",
    );

    const models = await adapter.fetchAll("openai", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "sk-test",
    });

    expect(models[0]?.capabilities?.reasoningEfforts).toEqual([
      "light",
      "medium",
      "high",
    ]);
  });

  it("normalizes camelCase provider capability metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-5.6-luna",
              capabilities: {
                reasoningEfforts: ["none", "low", "medium", "high"],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatibleModelCatalogAdapter(
      "openai",
      "https://api.openai.com/v1",
    );

    const models = await adapter.fetchAll("openai", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "sk-test",
    });

    expect(models[0]?.capabilities?.reasoningEfforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(models[0]?.capabilityMetadata).toMatchObject({
      source: "provider_api",
      confidence: "confirmed",
    });
  });

  it("uses provider-declared reasoning variants when returned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-5.6-luna",
              variants: {
                light: { reasoning_effort: "light" },
                max: { reasoning_effort: "max" },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatibleModelCatalogAdapter(
      "openai",
      "https://api.openai.com/v1",
    );

    const models = await adapter.fetchAll("openai", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "sk-test",
    });

    expect(models[0]?.capabilities?.reasoningEfforts).toEqual(["light", "max"]);
  });

  it("accepts the provider settings shape used by compatible catalogs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-5.6-luna",
              settings: { reasoningEfforts: ["low", "high"] },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatibleModelCatalogAdapter(
      "openai",
      "https://api.openai.com/v1",
    );

    const models = await adapter.fetchAll("openai", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "sk-test",
    });

    expect(models[0]?.capabilities?.reasoningEfforts).toEqual(["low", "high"]);
  });

  it("reads effort values from provider supported-parameter metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-5.6-luna",
              supported_parameters: {
                reasoning_effort: ["low", "high", "max"],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatibleModelCatalogAdapter(
      "openai",
      "https://api.openai.com/v1",
    );

    const models = await adapter.fetchAll("openai", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "sk-test",
    });

    expect(models[0]?.capabilities?.reasoningEfforts).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it("wraps network failures into typed discovery errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const adapter = new OpenAICompatibleModelCatalogAdapter(
      "openai",
      "https://api.openai.com/v1",
    );
    await expect(
      adapter.fetchAll("openai", {
        userId: "user-1",
        workspaceId: "ws-1",
        apiKey: "sk-test",
      }),
    ).rejects.toThrow("network error");
  });

  it("rejects invalid pagination cursors", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
        status: 200,
      }),
    );

    const adapter = new OpenAICompatibleModelCatalogAdapter(
      "openai",
      "https://api.openai.com/v1",
    );
    await expect(
      adapter.fetchPage({
        providerId: "openai",
        credentialContext: {
          userId: "user-1",
          workspaceId: "ws-1",
          apiKey: "sk-test",
        },
        limit: 10,
        cursor: "-1",
      }),
    ).rejects.toThrow("Invalid pagination cursor");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks auth failures as non-retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "invalid api key" },
        }),
        { status: 401 },
      ),
    );

    const adapter = new OpenAICompatibleModelCatalogAdapter(
      "openai",
      "https://api.openai.com/v1",
    );

    try {
      await adapter.fetchAll("openai", {
        userId: "user-1",
        workspaceId: "ws-1",
        apiKey: "sk-test",
      });
      throw new Error("Expected fetchAll to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderModelDiscoveryApiError);
      expect((error as ProviderModelDiscoveryApiError).retryable).toBe(false);
      expect((error as ProviderModelDiscoveryApiError).status).toBe(401);
    }
  });
});
