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
      model: {
        id: modelId,
        name: modelId,
        providerId: "openai",
        availability: "available",
      },
      resolveCredential,
    });
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockClear().mockImplementation(
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
    const encoder = new TextEncoder();
    const frame = (event: Record<string, unknown>) =>
      `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
      status: "completed",
    };
    const payload = {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Hi 🌍" }] },
        call,
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Safe summary" }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    };
    const completed = { type: "response.completed", response: payload };
    const events = [
      { type: "response.output_text.delta", delta: "Hi " },
      { type: "response.output_text.delta", delta: "🌍" },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...call, status: "in_progress", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"path":',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        arguments: call.arguments,
      },
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.output_item.done", output_index: 1, item: call },
      completed,
    ];
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "fixture-secret-never-echo",
      endpoint: "https://api.openai.com/v1/responses",
      providerId: "openai",
    });
    const params = {
      messages: [{ role: "user" as const, content: "stream" }],
      model: "fixture-model",
      system: "Be helpful",
      reasoningEffort: "low" as const,
      maxOutputTokens: 42,
      tools: {
        read_file: {
          description: "Read",
          parameters: z.object({ path: z.string() }),
        },
      },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const respond = (wire: string, width = 1) => {
      const bytes = encoder.encode(wire);
      const cancel = vi.fn();
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + width));
          offset = Math.min(bytes.length, offset + width);
        },
        cancel,
      });
      fetchSpy.mockResolvedValueOnce(
        new Response(body, {
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        }),
      );
      return cancel;
    };
    const wire = ": keepalive\r\n\r\n" + events.map(frame).join("");
    // Every byte split includes UTF-8 code points, JSON, fields and CRLF pairs.
    respond(wire);
    const stream = adapter.generateStream(params);
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "text", content: "Hi " },
      done: false,
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "text", content: "🌍" },
      done: false,
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        type: "tool-call",
        toolCall: {
          toolCallId: "call_1",
          toolName: "read_file",
          args: { path: "README.md" },
        },
      },
      done: false,
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        type: "finish",
        finishReason: "completed",
        usage: { totalTokens: 5 },
      },
      done: false,
    });
    await expect(stream.next()).resolves.toMatchObject({
      done: true,
      value: {
        content: "Hi 🌍",
        transcriptParts: [
          { type: "reasoning", text: "Safe summary", displaySafe: true },
        ],
      },
    });
    const request = fetchSpy.mock.calls[0];
    expect(request?.[0]).toBe("https://api.openai.com/v1/responses");
    const streamingBody = JSON.parse(String(request?.[1]?.body));
    expect(streamingBody).toMatchObject({
      stream: true,
      model: "fixture-model",
      max_output_tokens: 42,
      reasoning: { effort: "low", summary: "auto" },
      tools: [{ type: "function", name: "read_file" }],
    });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(payload)));
    await adapter.generate(params);
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual(
      Object.fromEntries(
        Object.entries(streamingBody).filter(([key]) => key !== "stream"),
      ),
    );

    // Same frames in one read, LF/CR framing and multiline data all remain SSE.
    for (const newline of ["\n", "\r", "\r\n"]) {
      const multiline = frame(completed).replace(
        'data: {"type":',
        'data: {\ndata: "type":',
      );
      respond(
        (events.slice(0, -1).map(frame).join("") + multiline).replace(
          /\r\n|\n/g,
          newline,
        ),
        65536,
      );
      const chunks = [];
      for await (const chunk of adapter.generateStream(params))
        chunks.push(chunk);
      expect(chunks.map((chunk) => chunk.type)).toEqual([
        "text",
        "text",
        "tool-call",
        "finish",
      ]);
    }

    const drain = async (wire: string) => {
      respond(wire, 65536);
      const chunks = [];
      try {
        for await (const chunk of adapter.generateStream(params))
          chunks.push(chunk);
        throw new Error("Expected stream failure");
      } catch (error) {
        expect(chunks.some((chunk) => chunk.type === "finish")).toBe(false);
        expect(String(error)).not.toContain("fixture-secret-never-echo");
        return { error, chunks };
      }
    };
    for (const type of ["response.failed", "response.incomplete", "error"]) {
      const { error, chunks } = await drain(
        frame(events[0]!) +
          frame({ type, message: "fixture-secret-never-echo" }),
      );
      expect(chunks.map((chunk) => chunk.type)).toEqual(["text"]);
      expect(error).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        retryable: type !== "response.incomplete",
      });
    }
    for (const malformed of [
      "data: not-json\n\n",
      "data: {}\n\n",
      frame({ type: "response.output_text.delta", delta: 42 }),
      frame({
        type: "response.output_item.done",
        item: { ...call, arguments: "{" },
      }),
      frame({
        type: "response.output_item.done",
        item: { ...call, call_id: undefined },
      }),
      frame({
        type: "response.output_item.done",
        item: { ...call, status: "incomplete" },
      }),
      frame({
        type: "response.completed",
        response: { ...payload, status: "incomplete" },
      }),
      frame(completed), // Final content cannot silently replace absent deltas.
      frame({ type: "response.output_text.delta", delta: "Hi " }), // EOF without terminal.
      frame(completed).slice(0, -2), // Unterminated terminal frame.
      "data: [DONE]\n\n",
    ]) {
      const { error, chunks } = await drain(malformed);
      expect(error).toMatchObject({
        code: "INVALID_RESPONSE_CONTRACT",
        retryable: false,
      });
      expect(chunks.some((chunk) => chunk.type === "tool-call")).toBe(false);
    }

    for (const oversized of [
      "data: " + "x".repeat(16 * 1024 * 1024 + 1),
      ("data: " + "x".repeat(8 * 1024 * 1024) + "\n").repeat(2),
    ]) {
      respond(oversized, oversized.length);
      await expect(adapter.generateStream(params).next()).rejects.toMatchObject(
        { code: "INVALID_RESPONSE_CONTRACT", retryable: false },
      );
    }

    // The first text is observable while the upstream remains open; early
    // return/abort must cancel that reader rather than wait for completion.
    for (const stop of ["return", "abort"]) {
      const cancel = vi.fn();
      const controller = new AbortController();
      fetchSpy.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(encoder.encode(frame(events[0]!)));
            },
            cancel,
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
      const partial = adapter.generateStream({
        ...params,
        signal: controller.signal,
      });
      await expect(partial.next()).resolves.toMatchObject({
        value: { type: "text", content: "Hi " },
      });
      if (stop === "return") await partial.return(undefined as never);
      else {
        const pending = partial.next();
        controller.abort();
        await expect(pending).rejects.toMatchObject({
          code: "ABORTED",
          retryable: false,
        });
      }
      expect(cancel).toHaveBeenCalledOnce();
      expect(
        (fetchSpy.mock.calls.at(-1)?.[1]?.signal as AbortSignal).aborted,
      ).toBe(true);
    }
    // Abort while suspended must not deliver a second already-buffered delta.
    respond(wire, 65536);
    const suspendedAbort = new AbortController();
    const suspended = adapter.generateStream({
      ...params,
      signal: suspendedAbort.signal,
    });
    await suspended.next();
    suspendedAbort.abort();
    await expect(suspended.next()).rejects.toMatchObject({ code: "ABORTED" });

    for (const status of [401, 429, 503]) {
      fetchSpy.mockResolvedValueOnce(
        new Response("fixture-secret-never-echo", { status }),
      );
      await expect(adapter.generateStream(params).next()).rejects.toMatchObject(
        { statusCode: status, retryable: status !== 401 },
      );
    }
    fetchSpy.mockRejectedValueOnce(new TypeError("fixture-secret-never-echo"));
    await expect(adapter.generateStream(params).next()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "[provider/openai-responses] Responses stream failed",
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(new Uint8Array([0xff]), {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    await expect(adapter.generateStream(params).next()).rejects.toMatchObject({
      code: "INVALID_RESPONSE_CONTRACT",
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "text/event-streamgarbage" },
      }),
    );
    await expect(adapter.generateStream(params).next()).rejects.toMatchObject({
      code: "INVALID_RESPONSE_CONTRACT",
    });

    vi.useFakeTimers();
    try {
      respond(wire, 65536);
      const buffered = adapter.generateStream(params);
      await buffered.next();
      await vi.advanceTimersByTimeAsync(150_000);
      await expect(buffered.next()).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(vi.getTimerCount()).toBe(0);
      const cancel = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
      const pending = adapter.generateStream(params).next();
      const assertion = expect(pending).rejects.toMatchObject({
        code: "TIMEOUT",
        statusCode: 408,
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(150_000);
      await assertion;
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    const modelId = builtinProviderRegistry.listModels("openai")[0]!.modelId;
    const resolveCredential = vi.fn(async () => ({
      apiKey: "fixture-protected-stream",
    }));
    const protectedAdapter = createProtectedProviderAdapter({
      providerId: "openai",
      modelId,
      model: {
        id: modelId,
        name: modelId,
        providerId: "openai",
        availability: "available",
      },
      resolveCredential,
    });
    respond(wire, 65536);
    const protectedChunks = [];
    for await (const chunk of protectedAdapter.generateStream({
      ...params,
      model: modelId,
    }))
      protectedChunks.push(chunk);
    expect(protectedChunks.map((chunk) => chunk.type)).toEqual([
      "text",
      "text",
      "tool-call",
      "finish",
    ]);
    expect(resolveCredential).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenLastCalledWith(
      resolveProviderRuntimeRoute("openai", modelId)!.providerEndpoint,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fixture-protected-stream",
        }),
      }),
    );
    const aborted = new AbortController();
    aborted.abort();
    const before = fetchSpy.mock.calls.length;
    await expect(
      adapter.generateStream({ ...params, signal: aborted.signal }).next(),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(fetchSpy).toHaveBeenCalledTimes(before);
  });
});
