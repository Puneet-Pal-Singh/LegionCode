import { describe, expect, it } from "vitest";
import type { Env } from "../../types/ai";
import { getSDKModelConfig } from "./SDKModelFactory";

function createEnv(): Env {
  return {
    DEFAULT_MODEL: "gpt-4o-mini",
    OPENAI_API_KEY: "sk-env-openai-key",
  } as Env;
}

describe("SDKModelFactory", () => {
  it("returns google-native SDK config with the Gemini API base URL", () => {
    const config = getSDKModelConfig(
      "gemini-2.5-flash-lite",
      "google-native",
      createEnv(),
      "AIzaGoogleTestKey1234567890",
      "google",
    );

    expect(config).toEqual({
      provider: "google-native",
      apiKey: "AIzaGoogleTestKey1234567890",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash-lite",
    });
  });

  it("returns openai-compatible SDK config for Together", () => {
    const config = getSDKModelConfig(
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "openai-compatible",
      createEnv(),
      "together-api-key",
      "together",
    );

    expect(config).toEqual({
      provider: "openai-compatible",
      apiKey: "together-api-key",
      baseURL: "https://api.together.xyz/v1",
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    });
  });

  it("returns openai-compatible SDK config for Cerebras", () => {
    const config = getSDKModelConfig(
      "gpt-oss-120b",
      "openai-compatible",
      createEnv(),
      "cerebras-api-key",
      "cerebras",
    );

    expect(config).toEqual({
      provider: "openai-compatible",
      apiKey: "cerebras-api-key",
      baseURL: "https://api.cerebras.ai/v1",
      model: "gpt-oss-120b",
    });
  });

  it("uses explicit route base URL for discovered provider routes", () => {
    const config = getSDKModelConfig(
      "@cf/meta/llama-3.1-8b-instruct",
      "openai-compatible",
      createEnv(),
      "cloudflare-api-token",
      "cloudflare-ai",
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
    );

    expect(config).toEqual({
      provider: "openai-compatible",
      apiKey: "cloudflare-api-token",
      baseURL: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
      model: "@cf/meta/llama-3.1-8b-instruct",
    });
  });
});
