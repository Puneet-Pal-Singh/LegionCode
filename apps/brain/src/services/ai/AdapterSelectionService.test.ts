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
});
