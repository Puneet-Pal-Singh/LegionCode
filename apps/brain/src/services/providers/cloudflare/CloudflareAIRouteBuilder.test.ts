import { describe, expect, it } from "vitest";
import {
  buildCloudflareAIRoute,
  buildCloudflareAIRouteHeaders,
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

  it("uses the current Cloudflare REST endpoint for AI Gateway", () => {
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
      "https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1/chat/completions",
    );
  });

  it("routes a named AI Gateway through the required request header", () => {
    expect(
      buildCloudflareAIRouteHeaders({
        providerId: "cloudflare-ai",
        accountId: "account_123",
        gatewayId: "gateway-123",
        routeMode: "ai-gateway",
      }),
    ).toEqual({ "cf-aig-gateway-id": "gateway-123" });
  });

  it("defaults the AI Gateway request header when its ID is omitted", () => {
    expect(
      buildCloudflareAIRouteHeaders({
        providerId: "cloudflare-ai",
        accountId: "account_123",
        routeMode: "ai-gateway",
      }),
    ).toEqual({ "cf-aig-gateway-id": "default" });
  });

  it("preserves Workers AI model IDs for the Cloudflare REST API", () => {
    expect(
      resolveCloudflareRuntimeModelId(
        {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          routeMode: "ai-gateway",
        },
        "@cf/meta/llama-3.1-8b-instruct",
      ),
    ).toBe("@cf/meta/llama-3.1-8b-instruct");
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

  it("does not add gateway headers to direct Workers AI requests", () => {
    expect(
      buildCloudflareAIRouteHeaders({
        providerId: "cloudflare-ai",
        accountId: "account_123",
        routeMode: "workers-ai-direct",
      }),
    ).toBeUndefined();
  });
});
