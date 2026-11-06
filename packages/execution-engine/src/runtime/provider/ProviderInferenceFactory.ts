import type { ProviderModelTransport } from "@repo/shared-types";
import { ProviderError, type ProviderAdapter } from "./base/ProviderAdapter.js";
import { OpenAIAdapter } from "./adapters/OpenAIAdapter.js";
import { OpenAIResponsesAdapter } from "./adapters/OpenAIResponsesAdapter.js";
import { AnthropicMessagesAdapter } from "./adapters/AnthropicMessagesAdapter.js";
import { GoogleAdapter } from "./adapters/GoogleAdapter.js";

/** Trusted composition supplies credential, route and defaults; adapters only translate inference. */
export interface ProviderInferenceConfiguration {
  readonly providerId: string;
  readonly transport: ProviderModelTransport;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly defaultModel?: string;
  readonly headers?: Record<string, string>;
}

export function createProviderInferenceAdapter(
  config: ProviderInferenceConfiguration,
): ProviderAdapter {
  const { providerId, apiKey, defaultModel, endpoint } = config;
  switch (config.transport) {
    case "openai-responses":
      return new OpenAIResponsesAdapter({
        providerId,
        apiKey,
        defaultModel,
        endpoint,
      });
    case "anthropic-messages":
      return new AnthropicMessagesAdapter({
        providerId,
        apiKey,
        defaultModel,
        endpoint,
      });
    case "openai-chat-completions":
      return new OpenAIAdapter({
        providerId,
        apiKey,
        defaultModel,
        baseURL: toOpenAICompatibleBaseURL(endpoint),
        headers: config.headers,
      });
    case "google-generative":
      return new GoogleAdapter({
        providerId,
        apiKey,
        defaultModel,
        baseURL: endpoint,
      });
    default:
      throw new ProviderError(
        providerId,
        `Provider transport "${config.transport}" is not wired for runtime inference yet.`,
      );
  }
}

export function toOpenAICompatibleBaseURL(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}
