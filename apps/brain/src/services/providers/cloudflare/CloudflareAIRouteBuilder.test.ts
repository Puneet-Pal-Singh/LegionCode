import { describe, expect, it } from "vitest";
import {
  buildCloudflareAIRoute,
  resolveCloudflareRuntimeModelId,
} from "./CloudflareAIRouteBuilder";

describe("CloudflareAIRouteBuilder", () => {
  it("builds direct Workers AI chat-completions routes", () => {
    expect(
      buildCloudflareAIRoute({
        config: {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          routeMode: "workers-ai-direct",
        },
        modelId: "@cf/meta/llama-3.1-8b-instruct",
        transport: "openai-chat-completions",
      }),
    ).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1/chat/completions",
    );
  });

  it("defaults AI Gateway ID when omitted", () => {
    expect(
      buildCloudflareAIRoute({
        config: {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          routeMode: "ai-gateway",
        },
        modelId: "@cf/meta/llama-3.1-8b-instruct",
        transport: "openai-chat-completions",
      }),
    ).toBe(
      "https://gateway.ai.cloudflare.com/v1/account_123/default/compat/chat/completions",
    );
  });

  it("builds AI Gateway compat chat-completions routes", () => {
    expect(
      buildCloudflareAIRoute({
        config: {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          gatewayId: "gateway-123",
          routeMode: "ai-gateway",
        },
        modelId: "@cf/meta/llama-3.1-8b-instruct",
        transport: "openai-chat-completions",
      }),
    ).toBe(
      "https://gateway.ai.cloudflare.com/v1/account_123/gateway-123/compat/chat/completions",
    );
  });

  it("prefixes Workers AI models for AI Gateway compat routes", () => {
    expect(
      resolveCloudflareRuntimeModelId(
        {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          routeMode: "ai-gateway",
        },
        "@cf/meta/llama-3.1-8b-instruct",
      ),
    ).toBe("workers-ai/@cf/meta/llama-3.1-8b-instruct");
  });

  it("preserves direct Workers AI model IDs", () => {
    expect(
      resolveCloudflareRuntimeModelId(
        {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          routeMode: "workers-ai-direct",
        },
        "@cf/meta/llama-3.1-8b-instruct",
      ),
    ).toBe("@cf/meta/llama-3.1-8b-instruct");
  });
});
