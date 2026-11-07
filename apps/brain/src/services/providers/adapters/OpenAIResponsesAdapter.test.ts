import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAIResponsesAdapter } from "@legioncode/execution-engine/runtime/provider/adapters/OpenAIResponsesAdapter";
import {
  builtinProviderRegistry,
  resolveProviderRuntimeRoute,
} from "@repo/provider-core";
import {
  createProtectedProviderAdapter,
  type ProtectedProviderCredential,
} from "@legioncode/execution-engine/runtime/provider/ProtectedProviderInference";
import { PNG_DATA_URL } from "../../chat/__tests__/ImageFixtures";

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

    const modelId = builtinProviderRegistry.listModels("openai")[0]?.modelId;
    if (!modelId)
      throw new Error("Expected an existing registered OpenAI model");
    const route = resolveProviderRuntimeRoute("openai", modelId)!;
    let credential: ProtectedProviderCredential | null = {
      apiKey: "fixture-protected-first",
    };
    const resolveCredential = vi.fn(async () => credential);
    const native = createProtectedProviderAdapter({
      providerId: "openai",
      modelId,
      resolveCredential,
    });
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy
      .mockClear()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              output_text: "Done",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200 },
          ),
      );
    await expect(
      native.generate({
        messages: [{ role: "user", content: "native hello" }],
      }),
    ).resolves.toMatchObject({ content: "Done" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      route.providerEndpoint,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fixture-protected-first",
        }),
      }),
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)).model).toBe(
      route.runtimeModelId,
    );

    credential = { apiKey: "fixture-protected-replaced" };
    await native.generate({ messages: [{ role: "user", content: "second" }] });
    expect(fetchSpy).toHaveBeenLastCalledWith(
      route.providerEndpoint,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fixture-protected-replaced",
        }),
      }),
    );
    expect(resolveCredential).toHaveBeenCalledTimes(2);
    credential = null;
    fetchSpy.mockClear();
    await expect(native.generate({ messages: [] })).rejects.toMatchObject({
      code: "AUTH_FAILED",
      retryable: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const cancelled = new AbortController();
    cancelled.abort();
    const readsBeforeAbort = resolveCredential.mock.calls.length;
    await expect(
      native.generate({ messages: [], signal: cancelled.signal }),
    ).rejects.toMatchObject({ code: "ABORTED", retryable: false });
    expect(resolveCredential).toHaveBeenCalledTimes(readsBeforeAbort);
    await expect(
      adapter.generate({
        messages: [],
        model: "gpt-5.5",
        signal: cancelled.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(
      native.generate({ messages: [], model: "different-selection" }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_CONFIGURATION" });
    expect(resolveCredential).toHaveBeenCalledTimes(readsBeforeAbort);

    credential = { apiKey: "fixture-protected-repaired" };
    for (const statusCode of [401, 503, 502]) {
      fetchSpy
        .mockClear()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { message: credential.apiKey } }),
            { status: statusCode },
          ),
        );
      const error = await native
        .generate({ messages: [] })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        statusCode,
        retryable: statusCode >= 500,
        code: statusCode === 401 ? "AUTH_FAILED" : "PROVIDER_UNAVAILABLE",
      });
      expect(JSON.stringify(error)).not.toContain(credential.apiKey);
      expect(String(error)).not.toContain(credential.apiKey);
      expect(error).toHaveProperty("cause", undefined);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
    fetchSpy.mockClear().mockRejectedValue(new Error(credential.apiKey));
    const networkFailure = await native
      .generate({ messages: [] })
      .catch((failure: unknown) => failure);
    expect(networkFailure).toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });
    expect(String(networkFailure)).not.toContain(credential.apiKey);
    expect(networkFailure).toHaveProperty("cause", undefined);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy
      .mockClear()
      .mockResolvedValue(new Response("{bad", { status: 200 }));
    await expect(native.generate({ messages: [] })).rejects.toMatchObject({
      code: "INVALID_RESPONSE_CONTRACT",
      statusCode: 502,
      retryable: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const stopDuringLookup = new AbortController();
    let releaseCredential!: (value: ProtectedProviderCredential | null) => void;
    resolveCredential.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCredential = resolve;
        }),
    );
    fetchSpy.mockClear();
    const pendingLookup = native.generate({
      messages: [],
      signal: stopDuringLookup.signal,
    });
    stopDuringLookup.abort();
    releaseCredential(credential);
    await expect(pendingLookup).rejects.toMatchObject({
      code: "ABORTED",
      retryable: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      fetchSpy.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("fixture deadline")),
              { once: true },
            );
          }),
      );
      const timedOut = native.generate({ messages: [] });
      const checkedTimeout = expect(timedOut).rejects.toMatchObject({
        code: "TIMEOUT",
        statusCode: 408,
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(150_000);
      await checkedTimeout;
    } finally {
      vi.useRealTimers();
    }
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
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(body).not.toHaveProperty("temperature");
  });

  it("preserves only provider-designated display-safe reasoning summaries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "reasoning",
              content: [{ type: "reasoning_text", text: "Private reasoning" }],
              summary: [
                { type: "summary_text", text: "Comparing the two routes." },
                { type: "other", text: "Do not display this." },
              ],
            },
            {
              type: "message",
              content: [{ type: "output_text", text: "Done" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "sk-test",
      endpoint: "https://api.openai.com/v1/responses",
      providerId: "openai",
    });

    const result = await adapter.generate({
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-5.6",
      reasoningEffort: "medium",
    });

    expect(result.transcriptParts).toEqual([
      {
        type: "reasoning",
        text: "Comparing the two routes.",
        displaySafe: true,
      },
    ]);
  });

  it("forwards attached images as native Responses input_image parts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ output_text: "A screenshot" }), {
        status: 200,
      }),
    );
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "sk-test",
      endpoint: "https://api.openai.com/v1/responses",
      providerId: "openai",
    });

    await adapter.generate({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is shown?" },
            {
              type: "image",
              image: PNG_DATA_URL,
              mimeType: "image/png",
            },
          ],
        },
      ],
      model: "gpt-5.6",
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is shown?" },
          {
            type: "input_image",
            image_url: PNG_DATA_URL,
            detail: "auto",
          },
        ],
      },
    ]);
  });

  it("converts Zod coding-tool schemas for Responses function tools", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "function_call",
              call_id: "call_prs",
              name: "list_pull_requests",
              arguments: JSON.stringify({ owner: "acme", repo: "legion" }),
            },
          ],
          status: "completed",
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "sk-test",
      endpoint: "https://api.openai.com/v1/responses",
      providerId: "openai",
    });

    const result = await adapter.generate({
      messages: [{ role: "user", content: "read the readme" }],
      tools: {
        list_pull_requests: {
          description: "List pull requests",
          parameters: z.object({
            owner: z.string(),
            repo: z.string(),
            state: z.enum(["open", "closed", "all"]).optional(),
            head: z.string().optional(),
            mergedLimit: z.number().optional(),
            page: z.number().optional(),
            perPage: z.number().optional(),
          }),
        },
      },
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
    });

    expect(result.toolCalls).toEqual([
      {
        toolCallId: "call_prs",
        toolName: "list_pull_requests",
        args: { owner: "acme", repo: "legion" },
      },
    ]);

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "list_pull_requests",
        description: "List pull requests",
        strict: false,
        parameters: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            state: { type: "string", enum: ["open", "closed", "all"] },
            head: { type: "string" },
            mergedLimit: { type: "number" },
            page: { type: "number" },
            perPage: { type: "number" },
          },
          required: ["owner", "repo"],
          additionalProperties: false,
        },
      },
    ]);
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
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
