import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMissingGoogleThoughtSignaturesToRequestBody,
  GoogleAdapter,
} from "./GoogleAdapter";
import { LLMUnusableResponseError } from "@shadowbox/execution-engine/runtime";

const mockGenerateText = vi.fn();
const mockStreamText = vi.fn();
const mockGoogleModel = vi.fn();
const mockCreateGoogleGenerativeAI = vi.fn(() => mockGoogleModel);

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  streamText: (...args: unknown[]) => mockStreamText(...args),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (...args: unknown[]) =>
    mockCreateGoogleGenerativeAI(...args),
}));

describe("GoogleAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGoogleModel.mockReturnValue({ modelId: "gemini-2.5-flash-lite" });
  });

  it("classifies malformed empty candidate responses from Gemini as unusable", async () => {
    mockGenerateText.mockRejectedValueOnce({
      statusCode: 200,
      responseBody: JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 3338,
          totalTokenCount: 3338,
        },
      }),
    });

    const adapter = new GoogleAdapter({
      apiKey: "google-test-key",
    });

    const result = adapter.generate({
      messages: [],
      model: "gemini-2.5-flash-lite",
      tools: {},
      temperature: 0.2,
    });

    await expect(result).rejects.toBeInstanceOf(LLMUnusableResponseError);
    await expect(result).rejects.toMatchObject({
      name: "LLMUnusableResponseError",
      providerId: "google",
      modelId: "gemini-2.5-flash-lite",
      anomalyCode: "EMPTY_CANDIDATE",
      finishReason: "stop",
      statusCode: 200,
      usage: {
        provider: "google",
        model: "gemini-2.5-flash-lite",
        promptTokens: 3338,
        completionTokens: 0,
        totalTokens: 3338,
        raw: {
          promptTokens: 3338,
          completionTokens: 0,
        },
      },
    });
  });

  it("rethrows non-recoverable generation errors", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("boom"));

    const adapter = new GoogleAdapter({
      apiKey: "google-test-key",
    });

    await expect(
      adapter.generate({
        messages: [],
        model: "gemini-2.5-flash-lite",
      }),
    ).rejects.toThrow("boom");
  });

  it("configures Google client with the Gemini thought-signature fetch bridge", () => {
    new GoogleAdapter({
      apiKey: "google-test-key",
    });

    expect(mockCreateGoogleGenerativeAI).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: expect.any(Function),
      }),
    );
  });

  it("adds the Gemini validator-skip thought signature to replayed function calls", () => {
    const body = JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: "Please inspect files" }],
        },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "list_files",
                args: { path: "src" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "list_files",
                response: { content: ["index.ts"] },
              },
            },
          ],
        },
      ],
    });

    const bridgedBody = addMissingGoogleThoughtSignaturesToRequestBody(body);

    const bridgedPayload = JSON.parse(String(bridgedBody)) as {
      contents: Array<{ parts: unknown[] }>;
    };

    expect(bridgedPayload.contents[1]?.parts[0]).toEqual({
      thoughtSignature: "skip_thought_signature_validator",
      functionCall: {
        name: "list_files",
        args: { path: "src" },
      },
    });
  });

  it("preserves existing Gemini thought signatures", () => {
    const body = JSON.stringify({
      contents: [
        {
          role: "model",
          parts: [
            {
              thoughtSignature: "provider-signature",
              functionCall: {
                name: "read_file",
                args: { path: "README.md" },
              },
            },
          ],
        },
      ],
    });

    expect(addMissingGoogleThoughtSignaturesToRequestBody(body)).toBe(body);
  });

  it("streams text, tool calls, and finish chunks incrementally", async () => {
    mockStreamText.mockReturnValueOnce({
      fullStream: createAsyncIterable([
        { type: "text-delta", textDelta: "Hello " },
        {
          type: "tool-call",
          toolName: "read_file",
          args: { path: "README.md" },
        },
        { type: "finish", finishReason: "stop" },
      ]),
      usage: Promise.resolve({ promptTokens: 10, completionTokens: 4 }),
      text: Promise.resolve("Hello "),
      finishReason: Promise.resolve("stop"),
      toolCalls: Promise.resolve([
        { toolName: "read_file", args: { path: "README.md" } },
      ]),
    });

    const adapter = new GoogleAdapter({
      apiKey: "google-test-key",
    });

    const stream = adapter.generateStream({
      messages: [],
      model: "gemini-2.5-flash-lite",
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text", content: "Hello " },
    });
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "tool-call",
        toolCall: {
          toolName: "read_file",
          args: { path: "README.md" },
        },
      },
    });
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "finish",
        finishReason: "stop",
      },
    });
    await expect(stream.next()).resolves.toMatchObject({
      done: true,
      value: {
        content: "Hello ",
        finishReason: "stop",
        toolCalls: [
          { toolName: "read_file", args: { path: "README.md" } },
        ],
        usage: {
          provider: "google",
          model: "gemini-2.5-flash-lite",
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
        },
      },
    });
  });
});

function createAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}
