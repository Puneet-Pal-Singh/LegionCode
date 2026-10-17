import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreMessage } from "ai";
import { PNG_DATA_URL } from "../../chat/__tests__/ImageFixtures";
import { AnthropicMessagesAdapter } from "./AnthropicMessagesAdapter";
import { GoogleAdapter } from "./GoogleAdapter";
import { OpenAIAdapter } from "./OpenAIAdapter";

const messages: CoreMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Inspect this screenshot" },
      { type: "image", image: PNG_DATA_URL, mimeType: "image/png" },
    ],
  },
];
const base64 = PNG_DATA_URL.split(",")[1];

describe("provider image wire formats", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends original pixels as an OpenAI-compatible image URL", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          created: 0,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Screenshot" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
        }),
      ),
    );
    await new OpenAIAdapter({ apiKey: "test-key" }).generate({
      messages,
      model: "gpt-4o",
    });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContainEqual({
      type: "image_url",
      image_url: { url: PNG_DATA_URL },
    });
  });

  it("sends pixels as native Anthropic base64 image content", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "Screenshot" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 1 },
        }),
      ),
    );
    await new AnthropicMessagesAdapter({
      apiKey: "test-key",
      endpoint: "https://api.anthropic.com/v1/messages",
      providerId: "anthropic",
    }).generate({ messages, model: "claude-sonnet-4-5" });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: base64 },
    });
  });

  it("sends pixels as Google inlineData with the declared MIME type", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "Screenshot" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 1,
            totalTokenCount: 21,
          },
        }),
      ),
    );
    await new GoogleAdapter({ apiKey: "test-key" }).generate({
      messages,
      model: "gemini-2.5-flash",
    });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.contents[0].parts).toContainEqual({
      inlineData: { mimeType: "image/png", data: base64 },
    });
  });
});
