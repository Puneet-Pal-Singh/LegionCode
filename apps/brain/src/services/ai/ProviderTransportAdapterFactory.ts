import type {
  ProviderConnectionConfig,
  ProviderModelTransport,
} from "@repo/shared-types";
import type { Env } from "../../types/ai";
import type { ProviderAdapter } from "../providers";
import { AnthropicMessagesAdapter, OpenAIResponsesAdapter } from "../providers";
import { ValidationError } from "../../domain/errors";
import {
  createGoogleAdapter,
  createOpenAIAdapter,
} from "./ProviderAdapterFactory";
import { buildCloudflareAIRouteHeaders } from "../providers/cloudflare/CloudflareAIRouteBuilder";

export interface ProviderTransportRoute {
  providerId: string;
  transport: ProviderModelTransport;
  endpoint: string;
}

export function createTransportAdapter(
  route: ProviderTransportRoute,
  env: Env,
  apiKey: string,
  connectionConfig?: ProviderConnectionConfig,
): ProviderAdapter {
  if (route.transport === "openai-chat-completions") {
    return createOpenAIAdapter(
      env,
      apiKey,
      toOpenAICompatibleBaseURL(route.endpoint),
      route.providerId,
      resolveTransportHeaders(route.providerId, connectionConfig),
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

  if (route.transport === "google-generative") {
    return createGoogleAdapter(
      env,
      apiKey,
      route.endpoint,
      route.providerId,
    );
  }

  throw new ValidationError(
    `Provider transport "${route.transport}" is not wired for runtime inference yet.`,
    "UNKNOWN_PROVIDER",
  );
}

function resolveTransportHeaders(
  providerId: string,
  connectionConfig: ProviderConnectionConfig | undefined,
): Record<string, string> | undefined {
  if (
    providerId === "cloudflare-ai" &&
    connectionConfig?.providerId === "cloudflare-ai"
  ) {
    return buildCloudflareAIRouteHeaders(connectionConfig);
  }
  return undefined;
}

export function toOpenAICompatibleBaseURL(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}
