import type { ProviderModelTransport } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import type { ProviderAdapter } from "../providers";
import { AnthropicMessagesAdapter, OpenAIResponsesAdapter } from "../providers";
import { ValidationError } from "../../domain/errors";
import { createOpenAIAdapter } from "./ProviderAdapterFactory";

export interface ProviderTransportRoute {
  providerId: string;
  transport: ProviderModelTransport;
  endpoint: string;
}

export function createTransportAdapter(
  route: ProviderTransportRoute,
  env: Env,
  apiKey: string,
): ProviderAdapter {
  if (route.transport === "openai-chat-completions") {
    return createOpenAIAdapter(
      env,
      apiKey,
      toOpenAICompatibleBaseURL(route.endpoint),
    );
  }

  if (route.transport === "openai-responses") {
    return new OpenAIResponsesAdapter({
      apiKey,
      endpoint: route.endpoint,
      providerId: route.providerId,
      defaultModel: env.DEFAULT_MODEL,
    });
  }

  if (route.transport === "anthropic-messages") {
    return new AnthropicMessagesAdapter({
      apiKey,
      endpoint: route.endpoint,
      providerId: route.providerId,
      defaultModel: env.DEFAULT_MODEL,
    });
  }

  throw new ValidationError(
    `Provider transport "${route.transport}" is not wired for runtime inference yet.`,
    "UNKNOWN_PROVIDER",
  );
}

export function toOpenAICompatibleBaseURL(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}
