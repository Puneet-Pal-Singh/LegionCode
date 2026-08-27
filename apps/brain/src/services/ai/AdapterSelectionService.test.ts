import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import type { ProviderAdapter } from "../providers";
import { OpenAIResponsesAdapter } from "../providers";
import { selectAdapter } from "./AdapterSelectionService";

function createDefaultAdapter(provider = "litellm"): ProviderAdapter {
  return {
    provider,
    supportedModels: [],
    supportsModel: () => true,
    generate: vi.fn(),
    generateStream: vi.fn(),
  };
}

function createEnv(): Env {
  return {
    DEFAULT_MODEL: "gpt-4o-mini",
    AXIS_OPENROUTER_API_KEY: "sk-or-axis-managed-key",
  } as Env;
}

describe("AdapterSelectionService", () => {
  it("creates a google adapter for google-native selections", async () => {
    const providerConfigService = {
      getApiKey: vi.fn(async (providerId: string) =>
        providerId === "google" ? "AIzaGoogleTestKey1234567890" : null,
      ),
      getConnectionConfig: vi.fn(async () => undefined),
    };

    const adapter = await selectAdapter(
      {
        model: "gemini-2.5-flash-lite",
        provider: "google",
        runtimeProvider: "google-native",
        fallback: false,
        providerId: "google",
      },
      createDefaultAdapter(),
      createEnv(),
      providerConfigService as never,
    );

    expect(adapter.provider).toBe("google");
    expect(adapter.supportsModel("gemini-2.5-flash-lite")).toBe(true);
  });

  it("selects by model transport route when route metadata is present", async () => {
    const providerConfigService = {
      getApiKey: vi.fn(async (providerId: string) =>
        providerId === "opencode-zen" ? "oc-test" : null,
      ),
      getConnectionConfig: vi.fn(async () => undefined),
    };

    const adapter = await selectAdapter(
      {
        model: "gpt-5.5",
        provider: "opencode-zen",
        runtimeProvider: "custom-http",
        fallback: false,
        providerId: "opencode-zen",
      },
      createDefaultAdapter(),
      createEnv(),
      providerConfigService as never,
      undefined,
      {
        providerId: "opencode-zen",
        transport: "openai-responses",
        endpoint: "https://opencode.ai/zen/v1/responses",
      },
    );

    expect(adapter).toBeInstanceOf(OpenAIResponsesAdapter);
    expect(adapter.provider).toBe("opencode-zen");
  });

  it("preserves the selected provider identity for openai-compatible adapters", async () => {
    const providerConfigService = {
      getApiKey: vi.fn(async (providerId: string) =>
        providerId === "openrouter" ? "sk-or-test-key" : null,
      ),
      getConnectionConfig: vi.fn(async () => undefined),
    };

    const adapter = await selectAdapter(
      {
        model: "poolside/laguna-s-2.1:free",
        provider: "openrouter",
        runtimeProvider: "openai-compatible",
        fallback: false,
        providerId: "openrouter",
      },
      createDefaultAdapter(),
      createEnv(),
      providerConfigService as never,
    );

    expect(adapter.provider).toBe("openrouter");
  });

  it("loads trusted Cloudflare connection config for gateway routing", async () => {
    const getConnectionConfig = vi.fn(async () => ({
      providerId: "cloudflare-ai" as const,
      accountId: "account_123",
      gatewayId: "gateway-123",
      routeMode: "ai-gateway" as const,
    }));
    const providerConfigService = {
      getApiKey: vi.fn(async () => "cf-test-token"),
      getConnectionConfig,
    };

    const adapter = await selectAdapter(
      {
        model: "@cf/zai-org/glm-4.7-flash",
        provider: "cloudflare-ai",
        runtimeProvider: "custom-http",
        fallback: false,
        providerId: "cloudflare-ai",
      },
      createDefaultAdapter(),
      createEnv(),
      providerConfigService as never,
      undefined,
      {
        providerId: "cloudflare-ai",
        transport: "openai-chat-completions",
        endpoint:
          "https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1/chat/completions",
      },
    );

    expect(adapter.provider).toBe("cloudflare-ai");
    expect(getConnectionConfig).toHaveBeenCalledWith("cloudflare-ai");
  });
});
