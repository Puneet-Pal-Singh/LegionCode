import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeGoModelCatalogAdapter } from "./OpenCodeGoModelCatalogAdapter";
import { ProviderModelDiscoveryApiError } from "../errors";

describe("OpenCodeGoModelCatalogAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the live inventory without guessing model transports", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen3.7-plus",
              name: "Qwen 3.7 Plus",
              context_window: 1000000,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const models = await new OpenCodeGoModelCatalogAdapter().fetchAll(
      "opencode-go",
      { apiKey: "oc-test" },
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: "qwen3.7-plus",
        providerId: "opencode-go",
        contextWindow: 1000000,
        availability: "unsupported_transport",
      }),
    ]);
    expect(models[0]?.runtimeRoute).toBeUndefined();
    expect(models[0]?.capabilities).toBeUndefined();
  });

  it("rejects unsupported provider IDs", async () => {
    await expect(
      new OpenCodeGoModelCatalogAdapter().fetchAll("openai", {
        apiKey: "oc-test",
      }),
    ).rejects.toThrow("unsupported provider");
  });

  it("wraps auth failures as non-retryable discovery errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
      }),
    );

    await expect(
      new OpenCodeGoModelCatalogAdapter().fetchAll("opencode-go", {
        apiKey: "oc-test",
      }),
    ).rejects.toMatchObject<Partial<ProviderModelDiscoveryApiError>>({
      retryable: false,
      status: 401,
    });
  });
});
