import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
              call_id: "call_readme",
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
        toolCallId: "call_readme",
        toolName: "read_file",
        args: { path: "README.md" },
      },
    ]);
  });

  it("sends reasoning and a bounded output budget for OpenAI reasoning models", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ output_text: "Done", status: "completed" }),
          { status: 200 },
        ),
      );
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "sk-test",
      endpoint: "https://api.openai.com/v1/responses",
      providerId: "openai",
    });

    await adapter.generate({
      messages: [{ role: "user", content: "hello" }],
      tools: {},
      model: "gpt-5.6-luna",
      temperature: 0.2,
      reasoningEffort: "high",
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      max_output_tokens: 4096,
      reasoning: { effort: "high" },
    });
    expect(body).not.toHaveProperty("temperature");
  });

  it("converts Zod coding-tool schemas for Responses function tools", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ output_text: "Done", status: "completed" }),
          { status: 200 },
        ),
      );
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "sk-test",
      endpoint: "https://api.openai.com/v1/responses",
      providerId: "openai",
    });

    await adapter.generate({
      messages: [{ role: "user", content: "read the readme" }],
      tools: {
        read_file: {
          description: "Read a file",
          parameters: z.object({ path: z.string() }),
        },
      },
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ]);
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("preserves structured assistant/tool history when building responses input", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: "Done",
          status: "completed",
          usage: {
            input_tokens: 5,
            output_tokens: 2,
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

    await adapter.generate({
      messages: [
        { role: "user", content: "read the readme" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_readme",
              toolName: "read_file",
              args: { path: "README.md" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_readme",
              toolName: "read_file",
              result: { content: "hello" },
            },
          ],
        },
      ],
      model: "gpt-5.5",
    });

    const init = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as {
      input: Array<Record<string, unknown>>;
    };
    expect(body.input).toEqual([
      { role: "user", content: "read the readme" },
      {
        type: "function_call",
        call_id: "call_readme",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
      {
        type: "function_call_output",
        call_id: "call_readme",
        output: '{"content":"hello"}',
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
