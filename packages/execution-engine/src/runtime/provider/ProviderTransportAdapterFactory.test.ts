import { describe, expect, it, vi } from "vitest";
import { AnthropicMessagesAdapter } from "./AnthropicMessagesAdapter.js";
import { GoogleAdapter } from "./GoogleAdapter.js";
import { OpenAIResponsesAdapter } from "./OpenAIResponsesAdapter.js";
import {
  createTransportAdapter,
  toOpenAICompatibleBaseURL,
} from "./ProviderTransportAdapterFactory";

const { mockCreateOpenAI } = vi.hoisted(() => ({
  mockCreateOpenAI: vi.fn(() => vi.fn()),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: mockCreateOpenAI,
}));

describe("ProviderTransportAdapterFactory", () => {
  it("creates a responses adapter for openai-responses routes", () => {
    const adapter = createTransportAdapter(
      {
        providerId: "opencode-zen",
        transport: "openai-responses",
        endpoint: "https://opencode.ai/zen/v1/responses",
      },
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

  it("creates a Google adapter with the logical OpenCode provider identity", () => {
    const adapter = createTransportAdapter(
      {
        providerId: "opencode-zen",
        transport: "google-generative",
        endpoint: "https://opencode.ai/zen/v1",
      },
      "oc-test",
    );

    expect(adapter).toBeInstanceOf(GoogleAdapter);
    expect(adapter.provider).toBe("opencode-zen");
  });

  it("preserves the logical provider for OpenAI-compatible transports", () => {
    const adapter = createTransportAdapter(
      {
        providerId: "openrouter",
        transport: "openai-chat-completions",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
      },
      "or-test",
    );

    expect(adapter.provider).toBe("openrouter");
  });

  it("passes the trusted Cloudflare gateway ID as an SDK request header", () => {
    createTransportAdapter(
      {
        providerId: "cloudflare-ai",
        transport: "openai-chat-completions",
        endpoint:
          "https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1/chat/completions",
      },
      "cf-test",
      {
        connectionConfig: {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          gatewayId: "gateway-123",
          routeMode: "ai-gateway",
        },
      },
    );

    expect(mockCreateOpenAI).toHaveBeenLastCalledWith(
      expect.objectContaining({
        apiKey: "cf-test",
        baseURL:
          "https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1",
        headers: { "cf-aig-gateway-id": "gateway-123" },
      }),
    );
  });

  it("rejects unwired transports", () => {
    expect(() =>
      createTransportAdapter(
        {
          providerId: "cloudflare-ai",
          transport: "cloudflare-ai-run",
          endpoint: "https://example.com/run",
        },
        "cf-test",
      ),
    ).toThrow("not wired");
  });
});
