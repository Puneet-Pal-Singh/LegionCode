import { describe, expect, it, vi } from "vitest";
import { findDiscoveredChatModelMetadata } from "./ChatModelMetadataResolver";

describe("findDiscoveredChatModelMetadata", () => {
  it("continues through discovery pages for the selected model", async () => {
    const getDiscoveredModels = vi
      .fn()
      .mockResolvedValueOnce({
        models: [],
        page: { limit: 200, hasMore: true, nextCursor: "200" },
      })
      .mockResolvedValueOnce({
        models: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            providerId: "openai",
            contextWindow: 400000,
            pricing: {
              inputPer1M: 5,
              outputPer1M: 30,
              currency: "USD",
            },
          },
        ],
        page: { limit: 200, hasMore: false },
      });

    await expect(
      findDiscoveredChatModelMetadata(
        { getDiscoveredModels },
        "openai",
        "gpt-5.5",
      ),
    ).resolves.toEqual({
      contextWindow: 400000,
      pricing: { inputPer1M: 5, outputPer1M: 30, currency: "USD" },
    });
    expect(getDiscoveredModels).toHaveBeenNthCalledWith(2, "openai", {
      view: "all",
      surface: "picker",
      limit: 200,
      cursor: "200",
    });
  });

  it("returns empty metadata when the selected model is not discovered", async () => {
    const getDiscoveredModels = vi.fn(async () => ({
      models: [],
      page: { limit: 200, hasMore: false },
    }));

    await expect(
      findDiscoveredChatModelMetadata(
        { getDiscoveredModels },
        "openai",
        "missing-model",
      ),
    ).resolves.toEqual({});
  });
});
