import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesAdapter } from "./AnthropicMessagesAdapter";

const mockGenerateText = vi.fn();
const mockStreamText = vi.fn();
const mockAnthropicModel = vi.fn();
const mockCreateAnthropic = vi.fn(() => mockAnthropicModel);

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  streamText: (...args: unknown[]) => mockStreamText(...args),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: (...args: unknown[]) => mockCreateAnthropic(...args),
}));

describe("AnthropicMessagesAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnthropicModel.mockReturnValue({ modelId: "claude-sonnet-4-6" });
  });

  it("configures Anthropic client from a messages endpoint", () => {
    new AnthropicMessagesAdapter({
      apiKey: "oc-test",
      endpoint: "https://opencode.ai/zen/v1/messages",
      providerId: "opencode-zen",
    });

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "oc-test",
        baseURL: "https://opencode.ai/zen/v1",
        headers: {
          Authorization: "Bearer oc-test",
        },
      }),
    );
  });

  it("generates text and normalizes usage", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Reviewed",
      usage: {
        promptTokens: 7,
        completionTokens: 4,
      },
      finishReason: "stop",
      toolCalls: [
        {
          toolName: "read_file",
          args: { path: "README.md" },
        },
      ],
    });

    const adapter = new AnthropicMessagesAdapter({
      apiKey: "oc-test",
      endpoint: "https://opencode.ai/zen/v1/messages",
      providerId: "opencode-zen",
    });

    const result = await adapter.generate({
      messages: [{ role: "user", content: "review" }],
      model: "claude-sonnet-4-6",
    });

    expect(result).toMatchObject({
      content: "Reviewed",
      finishReason: "stop",
      toolCalls: [
        {
          toolName: "read_file",
          args: { path: "README.md" },
        },
      ],
      usage: {
        provider: "opencode-zen",
        model: "claude-sonnet-4-6",
        promptTokens: 7,
        completionTokens: 4,
        totalTokens: 11,
      },
    });
  });

  it("streams text, tool calls, and finish chunks", async () => {
    mockStreamText.mockReturnValueOnce({
      fullStream: createAsyncIterable([
        { type: "text-delta", textDelta: "Hi" },
        {
          type: "tool-call",
          toolName: "read_file",
          args: { path: "README.md" },
        },
        {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 2, completionTokens: 1 },
        },
      ]),
      usage: Promise.resolve({ promptTokens: 2, completionTokens: 1 }),
      text: Promise.resolve("Hi"),
      finishReason: Promise.resolve("stop"),
      toolCalls: Promise.resolve([
        { toolName: "read_file", args: { path: "README.md" } },
      ]),
    });

    const adapter = new AnthropicMessagesAdapter({
      apiKey: "oc-test",
      endpoint: "https://opencode.ai/zen/v1/messages",
      providerId: "opencode-zen",
    });
    const stream = adapter.generateStream({
      messages: [{ role: "user", content: "stream" }],
      model: "claude-sonnet-4-6",
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text", content: "Hi" },
    });
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "tool-call",
        toolCall: { toolName: "read_file", args: { path: "README.md" } },
      },
    });
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "finish",
        usage: {
          provider: "opencode-zen",
          model: "claude-sonnet-4-6",
          promptTokens: 2,
          completionTokens: 1,
          totalTokens: 3,
        },
      },
    });
  });
});

async function* createAsyncIterable<T>(
  chunks: T[],
): AsyncGenerator<T, void, unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
}
