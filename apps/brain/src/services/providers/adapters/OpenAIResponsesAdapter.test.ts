import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIResponsesAdapter } from "./OpenAIResponsesAdapter";

describe("OpenAIResponsesAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates text and normalizes responses usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: "Done",
          status: "completed",
          usage: {
            input_tokens: 11,
            output_tokens: 3,
          },
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenAIResponsesAdapter({
      apiKey: "oc-test",
      endpoint: "https://opencode.ai/zen/v1/responses",
      providerId: "opencode-zen",
    });

    const result = await adapter.generate({
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-5.5",
    });

    expect(result).toMatchObject({
      content: "Done",
      finishReason: "completed",
      usage: {
        provider: "opencode-zen",
        model: "gpt-5.5",
        promptTokens: 11,
        completionTokens: 3,
        totalTokens: 14,
      },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://opencode.ai/zen/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer oc-test",
        }),
      }),
    );
  });

  it("normalizes function-call output items", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "function_call",
              name: "read_file",
              arguments: '{"path":"README.md"}',
            },
          ],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 1,
          },
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenAIResponsesAdapter({
      apiKey: "oc-test",
      endpoint: "https://opencode.ai/zen/v1/responses",
      providerId: "opencode-zen",
    });

    const result = await adapter.generate({
      messages: [{ role: "user", content: "read" }],
      model: "gpt-5.5",
    });

    expect(result.toolCalls).toEqual([
      {
        toolName: "read_file",
        args: { path: "README.md" },
      },
    ]);
  });

  it("simulates stream chunks from a responses generation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: "Streamed",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        }),
        { status: 200 },
      ),
    );

    const adapter = new OpenAIResponsesAdapter({
      apiKey: "oc-test",
      endpoint: "https://opencode.ai/zen/v1/responses",
      providerId: "opencode-zen",
    });
    const stream = adapter.generateStream({
      messages: [{ role: "user", content: "stream" }],
      model: "gpt-5.5",
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text", content: "Streamed" },
    });
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: "finish" },
    });
  });
});
