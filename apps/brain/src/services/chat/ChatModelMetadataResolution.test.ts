import { describe, expect, it, vi } from "vitest";
import { resolveChatModelMetadata } from "./ChatModelMetadataResolution";

describe("resolveChatModelMetadata", () => {
  it("returns discovered metadata for a valid selected model", async () => {
    const fetchModels = vi.fn(async () => ({
      models: [
        {
          id: "gpt-5",
          name: "GPT-5",
          providerId: "openai",
          capabilities: { reasoningEfforts: ["low"] },
          runtimeRoute: {
            providerId: "openai",
            modelId: "gpt-5",
            transport: "openai-responses",
            endpoint: "https://api.openai.com/v1/responses",
          },
        },
      ],
      page: { limit: 200, hasMore: false },
    }));

    await expect(
      resolveChatModelMetadata({
        providerId: "openai",
        modelId: "gpt-5",
        fetchModels,
      }),
    ).resolves.toMatchObject({
      reasoningEfforts: ["low"],
      runtimeRoute: {
        transport: "openai-responses",
        endpoint: "https://api.openai.com/v1/responses",
      },
    });
  });

  it("fails closed when the provider id is invalid", async () => {
    await expect(
      resolveChatModelMetadata({
        providerId: "invalid",
        modelId: "gpt-5",
        fetchModels: vi.fn(),
      }),
    ).resolves.toEqual({});
  });
});
