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
          data: [
            { id: "gpt-4o" },
            { id: "gpt-4o-mini" },
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

    expect(models).toHaveLength(2);
    expect(models[0].providerId).toBe("openai");
    expect(models[0].id).toBe("gpt-4o");
  });

  it("publishes model-specific reasoning efforts for new OpenAI families", async () => {
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

    expect(models[0]?.capabilities?.reasoningEfforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(models[1]?.capabilities?.reasoningEfforts).toEqual(["high"]);
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
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 }),
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
      expect(
        (error as ProviderModelDiscoveryApiError).retryable,
      ).toBe(false);
      expect((error as ProviderModelDiscoveryApiError).status).toBe(401);
    }
  });
});
