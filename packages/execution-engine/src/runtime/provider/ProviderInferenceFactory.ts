import type { ZodSchema } from "zod";
import type { LLMUsage } from "../cost/types.js";
import type { ProviderModelTransport } from "@repo/shared-types";
import { ProviderError, type GenerationParams, type ProviderAdapter } from "./base/ProviderAdapter.js";
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

export interface ProviderStructuredInferenceAdapter {
  generate<T>(params: GenerationParams & { readonly schema: ZodSchema<T> }): Promise<{ object: T; usage: LLMUsage }>;
}

/** Structured transport is explicit; unsupported routes never select another API. */
export function createStructuredProviderInferenceAdapter(
  config: ProviderInferenceConfiguration,
): ProviderStructuredInferenceAdapter {
  if (config.transport !== "openai-responses" || Object.keys(config.headers ?? {}).length > 0) {
    throw new ProviderError(config.providerId, "Structured provider transport or header profile is unsupported", undefined,
      { code: "INVALID_PROVIDER_CONFIGURATION", retryable: false });
  }
  const adapter = new OpenAIResponsesAdapter(config);
  return {
    generate<T>({ schema, ...params }: GenerationParams & { readonly schema: ZodSchema<T> }) {
      return adapter.generateStructured(params, schema);
    },
  };
}

export function toOpenAICompatibleBaseURL(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}
