import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareAIModelCatalogAdapter } from "./CloudflareAIModelCatalogAdapter";
import { ProviderModelDiscoveryApiError } from "../errors";

describe("CloudflareAIModelCatalogAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes Workers AI text-generation models with direct routes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              id: "@cf/meta/llama-3.1-8b-instruct",
              name: "Llama 3.1 8B Instruct",
              task: "Text Generation",
              context_window: 8192,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = new CloudflareAIModelCatalogAdapter();
    const models = await adapter.fetchAll("cloudflare-ai", {
      apiKey: "cf-token",
      connectionConfig: {
        providerId: "cloudflare-ai",
        accountId: "account_123",
        routeMode: "workers-ai-direct",
      },
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "@cf/meta/llama-3.1-8b-instruct",
      providerId: "cloudflare-ai",
      availability: "available",
      runtimeRoute: {
        providerId: "cloudflare-ai",
        modelId: "@cf/meta/llama-3.1-8b-instruct",
        transport: "openai-chat-completions",
        endpoint:
          "https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1/chat/completions",
      },
    });
  });

  it("requires Cloudflare connection config", async () => {
    const adapter = new CloudflareAIModelCatalogAdapter();

    await expect(
      adapter.fetchAll("cloudflare-ai", {
        apiKey: "cf-token",
      }),
    ).rejects.toThrow("account connection config");
  });

  it("normalizes AI Gateway models with compat routes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              id: "@cf/meta/llama-3.1-8b-instruct",
              name: "Llama 3.1 8B Instruct",
              task: "Text Generation",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = new CloudflareAIModelCatalogAdapter();
    const models = await adapter.fetchAll("cloudflare-ai", {
      apiKey: "cf-token",
      connectionConfig: {
        providerId: "cloudflare-ai",
        accountId: "account_123",
        routeMode: "ai-gateway",
      },
    });

    expect(models[0]?.runtimeRoute).toMatchObject({
      providerId: "cloudflare-ai",
      modelId: "workers-ai/@cf/meta/llama-3.1-8b-instruct",
      transport: "openai-chat-completions",
      endpoint:
        "https://gateway.ai.cloudflare.com/v1/account_123/default/compat/chat/completions",
    });
  });

  it("wraps auth errors as non-retryable discovery errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [{ message: "invalid token" }],
        }),
        { status: 403 },
      ),
    );

    const adapter = new CloudflareAIModelCatalogAdapter();

    try {
      await adapter.fetchAll("cloudflare-ai", {
        apiKey: "cf-token",
        connectionConfig: {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          routeMode: "workers-ai-direct",
        },
      });
      throw new Error("Expected fetchAll to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderModelDiscoveryApiError);
      expect((error as ProviderModelDiscoveryApiError).retryable).toBe(false);
      expect((error as ProviderModelDiscoveryApiError).status).toBe(403);
    }
  });
});
