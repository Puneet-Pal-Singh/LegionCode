import { describe, expect, it } from "vitest";
import type { Env } from "../../types/ai";
import { AnthropicMessagesAdapter, OpenAIResponsesAdapter } from "../providers";
import {
  createTransportAdapter,
  toOpenAICompatibleBaseURL,
} from "./ProviderTransportAdapterFactory";

describe("ProviderTransportAdapterFactory", () => {
  it("creates a responses adapter for openai-responses routes", () => {
    const adapter = createTransportAdapter(
      {
        providerId: "opencode-zen",
        transport: "openai-responses",
        endpoint: "https://opencode.ai/zen/v1/responses",
      },
      createEnv(),
      "oc-test",
    );

    expect(adapter).toBeInstanceOf(OpenAIResponsesAdapter);
    expect(adapter.provider).toBe("opencode-zen");
  });

  it("creates a messages adapter for anthropic-messages routes", () => {
    const adapter = createTransportAdapter(
      {
        providerId: "opencode-zen",
        transport: "anthropic-messages",
        endpoint: "https://opencode.ai/zen/v1/messages",
      },
      createEnv(),
      "oc-test",
    );

    expect(adapter).toBeInstanceOf(AnthropicMessagesAdapter);
    expect(adapter.provider).toBe("opencode-zen");
  });

  it("derives OpenAI-compatible base URL from chat-completions endpoint", () => {
    expect(
      toOpenAICompatibleBaseURL(
        "https://opencode.ai/zen/go/v1/chat/completions",
      ),
    ).toBe("https://opencode.ai/zen/go/v1");
  });

  it("rejects unwired transports", () => {
    expect(() =>
      createTransportAdapter(
        {
          providerId: "cloudflare-ai",
          transport: "cloudflare-ai-run",
          endpoint: "https://example.com/run",
        },
        createEnv(),
        "cf-test",
      ),
    ).toThrow("not wired");
  });
});

function createEnv(): Env {
  return {
    DEFAULT_MODEL: "gpt-4o-mini",
  } as Env;
}
