import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeGoModelCatalogAdapter } from "./OpenCodeGoModelCatalogAdapter";
import { ProviderModelDiscoveryApiError } from "../errors";

describe("OpenCodeGoModelCatalogAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks chat-completions models as available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "kimi-k2.6",
              name: "Kimi K2.6",
              context_window: 262144,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenCodeGoModelCatalogAdapter();
    const models = await adapter.fetchAll("opencode-go", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "oc-test",
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "kimi-k2.6",
      name: "Kimi K2.6",
      providerId: "opencode-go",
      contextWindow: 262144,
      availability: "available",
      runtimeRoute: {
        providerId: "opencode-go",
        modelId: "kimi-k2.6",
        transport: "openai-chat-completions",
        endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
      },
    });
  });

  it("marks messages models as unsupported until messages transport is wired", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "qwen3.6-plus", name: "Qwen3.6 Plus" }],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenCodeGoModelCatalogAdapter();
    const models = await adapter.fetchAll("opencode-go", {
      apiKey: "oc-test",
    });

    expect(models[0]).toMatchObject({
      id: "qwen3.6-plus",
      availability: "unsupported_transport",
      capabilities: {
        supportsTools: false,
        supportsStructuredOutputs: false,
      },
      runtimeRoute: {
        transport: "anthropic-messages",
        endpoint: "https://opencode.ai/zen/go/v1/messages",
      },
      unavailableReason: "Anthropic Messages transport is not wired yet.",
    });
  });

  it("does not advertise structured output support for unknown unavailable models", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "new-model", name: "New Model" }],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenCodeGoModelCatalogAdapter();
    const models = await adapter.fetchAll("opencode-go", {
      apiKey: "oc-test",
    });

    expect(models[0]).toMatchObject({
      id: "new-model",
      availability: "unsupported_transport",
      capabilities: {
        supportsTools: false,
        supportsStructuredOutputs: false,
      },
    });
  });

  it("rejects unsupported provider IDs", async () => {
    const adapter = new OpenCodeGoModelCatalogAdapter();

    await expect(
      adapter.fetchAll("openai", {
        apiKey: "oc-test",
      }),
    ).rejects.toThrow("unsupported provider");
  });

  it("wraps auth failures as non-retryable discovery errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "invalid api key" },
        }),
        { status: 401 },
      ),
    );

    const adapter = new OpenCodeGoModelCatalogAdapter();

    try {
      await adapter.fetchAll("opencode-go", {
        apiKey: "oc-test",
      });
      throw new Error("Expected fetchAll to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderModelDiscoveryApiError);
      expect((error as ProviderModelDiscoveryApiError).retryable).toBe(false);
      expect((error as ProviderModelDiscoveryApiError).status).toBe(401);
    }
  });
});
