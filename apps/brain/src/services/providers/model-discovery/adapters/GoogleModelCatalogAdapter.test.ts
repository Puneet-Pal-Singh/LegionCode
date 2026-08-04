import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleModelCatalogAdapter } from "./GoogleModelCatalogAdapter";

describe("GoogleModelCatalogAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters for llm-capable models and normalizes payload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-1.5-pro",
              displayName: "Gemini 1.5 Pro",
              supportedGenerationMethods: ["generateContent"],
              inputTokenLimit: 1048576,
            },
            {
              name: "models/text-embedding-004",
              displayName: "Text Embedding 004",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = new GoogleModelCatalogAdapter();
    const models = await adapter.fetchAll("google", {
      userId: "user-1",
      workspaceId: "ws-1",
      apiKey: "AIza-test",
    });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("gemini-1.5-pro");
    expect(models[0].providerId).toBe("google");
    expect(models[0].contextWindow).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models",
      expect.objectContaining({
        headers: {
          "x-goog-api-key": "AIza-test",
        },
      }),
    );
  });

  it("fails fast on malformed cursors", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [{ name: "models/gemini-1.5-pro" }],
        }),
        { status: 200 },
      ),
    );

    const adapter = new GoogleModelCatalogAdapter();
    await expect(
      adapter.fetchPage({
        providerId: "google",
        credentialContext: {
          userId: "user-1",
          workspaceId: "ws-1",
          apiKey: "AIza-test",
        },
        limit: 10,
        cursor: "abc",
      }),
    ).rejects.toThrow("Invalid Google pagination cursor");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
