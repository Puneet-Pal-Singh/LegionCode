import { describe, expect, it } from "vitest";
import type { ProviderAdapter, GenerationParams } from "../providers";
import { createChatStream } from "./StreamGenerationService";

describe("createChatStream", () => {
  it("passes provider-owned reasoning effort labels to the adapter", async () => {
    let received: GenerationParams | undefined;
    const usage = {
      provider: "test-provider",
      model: "test-model",
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    };
    const adapter: ProviderAdapter = {
      provider: "test-provider",
      supportedModels: [],
      async generate() {
        return { content: "", usage };
      },
      async *generateStream(params) {
        received = params;
        yield { type: "finish", usage, finishReason: "stop" };
        return { content: "", usage, finishReason: "stop" };
      },
    };

    const stream = createChatStream(adapter, {
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      reasoningEffort: "light",
    });
    await new Response(stream).text();

    expect(received?.reasoningEffort).toBe("light");
  });
});
