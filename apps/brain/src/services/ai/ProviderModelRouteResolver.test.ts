import { describe, expect, it } from "vitest";
import { ValidationError } from "../../domain/errors";
import { ProviderModelRouteResolver } from "./ProviderModelRouteResolver";

describe("ProviderModelRouteResolver", () => {
  it("resolves OpenAI-compatible providers to chat completions", () => {
    const resolver = new ProviderModelRouteResolver();

    expect(
      resolver.resolve({
        providerId: "opencode-go",
        modelId: "opencode-go/kimi-k2.6",
      }),
    ).toEqual({
      providerId: "opencode-go",
      modelId: "opencode-go/kimi-k2.6",
      runtimeModelId: "kimi-k2.6",
      transport: "openai-chat-completions",
      endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
    });
  });

  it("resolves Google-native providers to generative transport", () => {
    const resolver = new ProviderModelRouteResolver();

    expect(
      resolver.resolve({
        providerId: "google",
        modelId: "gemini-2.5-flash-lite",
      }),
    ).toMatchObject({
      providerId: "google",
      runtimeModelId: "gemini-2.5-flash-lite",
      transport: "google-generative",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
    });
  });

  it("uses discovered route metadata when supplied", () => {
    const resolver = new ProviderModelRouteResolver();

    expect(
      resolver.resolve({
        providerId: "opencode-zen",
        modelId: "opencode-zen/gpt-5.1-codex",
        discoveredRoute: {
          providerId: "opencode-zen",
          modelId: "gpt-5.1-codex",
          transport: "openai-responses",
          endpoint: "https://opencode.ai/zen/v1/responses",
        },
      }),
    ).toEqual({
      providerId: "opencode-zen",
      modelId: "opencode-zen/gpt-5.1-codex",
      runtimeModelId: "gpt-5.1-codex",
      transport: "openai-responses",
      endpoint: "https://opencode.ai/zen/v1/responses",
    });
  });

  it("requires discovered route metadata for mixed-transport providers", () => {
    const resolver = new ProviderModelRouteResolver();

    expect(() =>
      resolver.resolve({
        providerId: "opencode-zen",
        modelId: "opencode-zen/gpt-5.1-codex",
      }),
    ).toThrow(ValidationError);
  });

  it("requires Cloudflare config when resolving Cloudflare routes", () => {
    const resolver = new ProviderModelRouteResolver();

    expect(() =>
      resolver.resolve({
        providerId: "cloudflare-ai",
        modelId: "@cf/meta/llama-3.1-8b-instruct",
        discoveredRoute: {
          providerId: "cloudflare-ai",
          modelId: "@cf/meta/llama-3.1-8b-instruct",
          transport: "openai-chat-completions",
          endpoint:
            "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions",
        },
      }),
    ).toThrow("Cloudflare AI requires connection config");
  });

  it("accepts Cloudflare routes when config is present", () => {
    const resolver = new ProviderModelRouteResolver();

    expect(
      resolver.resolve({
        providerId: "cloudflare-ai",
        modelId: "@cf/meta/llama-3.1-8b-instruct",
        connectionConfig: {
          providerId: "cloudflare-ai",
          accountId: "acct_123",
          routeMode: "workers-ai-direct",
        },
        discoveredRoute: {
          providerId: "cloudflare-ai",
          modelId: "@cf/meta/llama-3.1-8b-instruct",
          transport: "openai-chat-completions",
          endpoint:
            "https://api.cloudflare.com/client/v4/accounts/acct_123/ai/v1/chat/completions",
        },
      }),
    ).toMatchObject({
      runtimeModelId: "@cf/meta/llama-3.1-8b-instruct",
      transport: "openai-chat-completions",
    });
  });
});
