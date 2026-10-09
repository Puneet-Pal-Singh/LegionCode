import type {
  ProviderConnectionConfig,
  ProviderModelTransport,
} from "@repo/shared-types";
import { AnthropicMessagesAdapter } from "./AnthropicMessagesAdapter.js";
import { GoogleAdapter } from "./GoogleAdapter.js";
import { OpenAIAdapter } from "./OpenAIAdapter.js";
import { OpenAIResponsesAdapter } from "./OpenAIResponsesAdapter.js";
import { buildCloudflareAIRouteHeaders } from "./cloudflare-route-headers.js";
import type { ProviderAdapter } from "./ProviderAdapter.js";

export interface ProviderTransportRoute {
  providerId: string;
  transport: ProviderModelTransport;
  endpoint: string;
  modelId?: string;
  runtimeModelId?: string;
}

export interface ProviderTransportAdapterOptions {
  defaultModel?: string;
  connectionConfig?: ProviderConnectionConfig;
}

export class ProviderTransportError extends Error {
  readonly code = "UNSUPPORTED_PROVIDER_TRANSPORT";

  constructor(transport: string) {
    super(`Provider transport "${transport}" is not wired for runtime inference yet.`);
    this.name = "ProviderTransportError";
  }
}

export function createTransportAdapter(
  route: ProviderTransportRoute,
  apiKey: string,
  options: ProviderTransportAdapterOptions = {},
): ProviderAdapter {
  const { defaultModel, connectionConfig } = options;

  if (route.transport === "openai-chat-completions") {
    return new OpenAIAdapter({
      apiKey,
      baseURL: toOpenAICompatibleBaseURL(route.endpoint),
      defaultModel,
      providerId: route.providerId,
      headers: resolveTransportHeaders(route.providerId, connectionConfig),
    });
  }

  if (route.transport === "openai-responses") {
    return new OpenAIResponsesAdapter({
      apiKey,
      endpoint: route.endpoint,
      providerId: route.providerId,
      defaultModel,
    });
  }

  if (route.transport === "anthropic-messages") {
    return new AnthropicMessagesAdapter({
      apiKey,
      endpoint: route.endpoint,
      providerId: route.providerId,
      defaultModel,
    });
  }

  if (route.transport === "google-generative") {
    return new GoogleAdapter({
      apiKey,
      baseURL: route.endpoint,
      providerId: route.providerId,
      defaultModel,
    });
  }

  throw new ProviderTransportError(route.transport);
}

export function toOpenAICompatibleBaseURL(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}

function resolveTransportHeaders(
  providerId: string,
  connectionConfig: ProviderConnectionConfig | undefined,
): Record<string, string> | undefined {
  if (
    (providerId === "cloudflare-ai" &&
      connectionConfig?.providerId === "cloudflare-ai") ||
    (providerId === "cloudflare-workers-ai" &&
      connectionConfig?.providerId === "cloudflare-workers-ai") ||
    (providerId === "cloudflare-ai-gateway" &&
      connectionConfig?.providerId === "cloudflare-ai-gateway")
  ) {
    return buildCloudflareAIRouteHeaders(connectionConfig);
  }
  return undefined;
}
