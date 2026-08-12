import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeZenModelCatalogAdapter } from "./OpenCodeZenModelCatalogAdapter";
import { ProviderModelDiscoveryApiError } from "../errors";

describe("OpenCodeZenModelCatalogAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the live inventory without guessing model transports", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-5.6-luna",
              name: "GPT 5.6 Luna",
              context_window: 400000,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const models = await new OpenCodeZenModelCatalogAdapter().fetchAll(
      "opencode-zen",
      { apiKey: "oc-test" },
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: "gpt-5.6-luna",
        name: "GPT 5.6 Luna",
        providerId: "opencode-zen",
        contextWindow: 400000,
        availability: "unsupported_transport",
      }),
    ]);
    expect(models[0]?.runtimeRoute).toBeUndefined();
    expect(models[0]?.capabilities).toBeUndefined();
  });

  it("rejects unsupported provider IDs", async () => {
    await expect(
      new OpenCodeZenModelCatalogAdapter().fetchAll("openai", {
        apiKey: "oc-test",
      }),
    ).rejects.toThrow("unsupported provider");
  });

  it("wraps auth failures as non-retryable discovery errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 403,
      }),
    );

    await expect(
      new OpenCodeZenModelCatalogAdapter().fetchAll("opencode-zen", {
        apiKey: "oc-test",
      }),
    ).rejects.toMatchObject<Partial<ProviderModelDiscoveryApiError>>({
      retryable: false,
      status: 403,
    });
  });
});
