import { describe, expect, it } from "vitest";
import { buildCloudflareAIRoute } from "./CloudflareAIRouteBuilder";

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

  it("requires gateway ID for AI Gateway routes", () => {
    expect(() =>
      buildCloudflareAIRoute({
        config: {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          routeMode: "ai-gateway",
        },
        modelId: "@cf/meta/llama-3.1-8b-instruct",
        transport: "openai-chat-completions",
      }),
    ).toThrow("gatewayId");
  });

  it("builds AI Gateway Workers AI chat-completions routes", () => {
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
      "https://gateway.ai.cloudflare.com/v1/account_123/gateway-123/workers-ai/v1/chat/completions",
    );
  });
});
