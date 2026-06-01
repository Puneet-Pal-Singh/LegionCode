import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeZenModelCatalogAdapter } from "./OpenCodeZenModelCatalogAdapter";
import { ProviderModelDiscoveryApiError } from "../errors";

describe("OpenCodeZenModelCatalogAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks chat-completions models as available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "glm-5.1",
              name: "GLM 5.1",
              context_window: 131072,
              endpoint: "https://opencode.ai/zen/v1/chat/completions",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenCodeZenModelCatalogAdapter();
    const models = await adapter.fetchAll("opencode-zen", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "oc-test",
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "glm-5.1",
      name: "GLM 5.1",
      providerId: "opencode-zen",
      contextWindow: 131072,
      availability: "available",
      runtimeRoute: {
        providerId: "opencode-zen",
        modelId: "glm-5.1",
        transport: "openai-chat-completions",
        endpoint: "https://opencode.ai/zen/v1/chat/completions",
      },
    });
  });

  it("marks responses models as unsupported until responses transport is wired", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-5.5",
              name: "GPT 5.5",
              endpoint: "https://opencode.ai/zen/v1/responses",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenCodeZenModelCatalogAdapter();
    const models = await adapter.fetchAll("opencode-zen", {
      apiKey: "oc-test",
    });

    expect(models[0]).toMatchObject({
      id: "gpt-5.5",
      availability: "unsupported_transport",
      capabilities: {
        supportsTools: false,
        supportsStructuredOutputs: false,
        supportsReasoning: false,
      },
      runtimeRoute: {
        transport: "openai-responses",
        endpoint: "https://opencode.ai/zen/v1/responses",
      },
      unavailableReason: "OpenAI Responses transport is not wired yet.",
    });
  });

  it("marks messages models as unsupported until messages transport is wired", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            api: "@ai-sdk/anthropic",
          },
        ]),
        { status: 200 },
      ),
    );

    const adapter = new OpenCodeZenModelCatalogAdapter();
    const models = await adapter.fetchAll("opencode-zen", {
      apiKey: "oc-test",
    });

    expect(models[0]).toMatchObject({
      id: "claude-sonnet-4-6",
      availability: "unsupported_transport",
      capabilities: {
        supportsTools: false,
      },
      runtimeRoute: {
        transport: "anthropic-messages",
        endpoint: "https://opencode.ai/zen/v1/messages",
      },
      unavailableReason: "Anthropic Messages transport is not wired yet.",
    });
  });

  it("does not advertise tool support for unknown unavailable models", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "surprise-model", name: "Surprise Model" }],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenCodeZenModelCatalogAdapter();
    const models = await adapter.fetchAll("opencode-zen", {
      apiKey: "oc-test",
    });

    expect(models[0]).toMatchObject({
      id: "surprise-model",
      availability: "unsupported_transport",
      capabilities: {
        supportsTools: false,
        supportsStructuredOutputs: false,
      },
    });
  });

  it("marks google models as unsupported until google transport is wired for Zen", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gemini-3.5-flash",
              name: "Gemini 3.5 Flash",
              package: "@ai-sdk/google",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenCodeZenModelCatalogAdapter();
    const models = await adapter.fetchAll("opencode-zen", {
      apiKey: "oc-test",
    });

    expect(models[0]).toMatchObject({
      id: "gemini-3.5-flash",
      availability: "unsupported_transport",
      runtimeRoute: {
        transport: "google-generative",
        endpoint: "https://opencode.ai/zen/v1/models/gemini-3.5-flash",
      },
      unavailableReason:
        "Google Generative transport is not wired for OpenCode Zen yet.",
    });
  });

  it("rejects unsupported provider IDs", async () => {
    const adapter = new OpenCodeZenModelCatalogAdapter();

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
        { status: 403 },
      ),
    );

    const adapter = new OpenCodeZenModelCatalogAdapter();

    try {
      await adapter.fetchAll("opencode-zen", {
        apiKey: "oc-test",
      });
      throw new Error("Expected fetchAll to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderModelDiscoveryApiError);
      expect((error as ProviderModelDiscoveryApiError).retryable).toBe(false);
      expect((error as ProviderModelDiscoveryApiError).status).toBe(403);
    }
  });
});
