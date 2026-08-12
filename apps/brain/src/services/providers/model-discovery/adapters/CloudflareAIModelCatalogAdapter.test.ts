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

  it("normalizes AI Gateway models with current REST routes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              id: "@cf/meta/llama-3.1-8b-instruct",
              display_name: "Llama 3.1 8B Instruct",
              task: { id: "text-generation", name: "Text Generation" },
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
      modelId: "@cf/meta/llama-3.1-8b-instruct",
      transport: "openai-chat-completions",
      endpoint:
        "https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1/chat/completions",
    });
    expect(models[0]?.name).toBe("Llama 3.1 8B Instruct");
    expect(models[0]?.capabilities).toBeUndefined();
  });

  it("requests the full non-experimental text-generation page", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: [] }), {
        status: 200,
      }),
    );

    await new CloudflareAIModelCatalogAdapter().fetchAll("cloudflare-ai", {
      apiKey: "cf-token",
      connectionConfig: {
        providerId: "cloudflare-ai",
        accountId: "account_123",
        routeMode: "workers-ai-direct",
      },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "task=Text%20Generation&per_page=100&hide_experimental=true&page=1",
      ),
      expect.any(Object),
    );
  });

  it("aggregates every Cloudflare model page", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [
              { id: "@cf/meta/model-one", task: "Text Generation" },
            ],
            result_info: { page: 1, per_page: 1, total_pages: 2 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                id: "@cf/meta/model-two",
                task: { id: "text-generation", name: "Text Generation" },
              },
            ],
            result_info: { page: 2, per_page: 1, total_pages: 2 },
          }),
          { status: 200 },
        ),
      );

    const models = await new CloudflareAIModelCatalogAdapter().fetchAll(
      "cloudflare-ai",
      {
        apiKey: "cf-token",
        connectionConfig: {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          routeMode: "workers-ai-direct",
        },
      },
    );

    expect(models.map((model) => model.id)).toEqual([
      "@cf/meta/model-one",
      "@cf/meta/model-two",
    ]);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("page=2"),
      expect.any(Object),
    );
  });

  it("rejects model pagination beyond the safety limit", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ id: "@cf/meta/model", task: "Text Generation" }],
            result_info: { page, per_page: 1, total_pages: 21 },
          }),
          { status: 200 },
        ),
      );
    });

    await expect(
      new CloudflareAIModelCatalogAdapter().fetchAll("cloudflare-ai", {
        apiKey: "cf-token",
        connectionConfig: {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          routeMode: "workers-ai-direct",
        },
      }),
    ).rejects.toThrow("20-page safety limit");
    expect(fetchSpy).toHaveBeenCalledTimes(20);
  });

  it("keeps only exact text-generation tasks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [
            { id: "@cf/meta/generation", task: "Text Generation" },
            { id: "@cf/baai/embedding", task: "Text Embeddings" },
            { id: "@cf/huggingface/classifier", task: "Text Classification" },
            { id: "@cf/stability/image", task: "Text-to-Image" },
          ],
        }),
        { status: 200 },
      ),
    );

    const models = await new CloudflareAIModelCatalogAdapter().fetchAll(
      "cloudflare-ai",
      {
        apiKey: "cf-token",
        connectionConfig: {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          routeMode: "workers-ai-direct",
        },
      },
    );

    expect(models.map((model) => model.id)).toEqual(["@cf/meta/generation"]);
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
