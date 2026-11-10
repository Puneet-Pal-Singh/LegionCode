import type {
  ProviderConnectionConfig,
  ProviderModelTransport,
} from "@repo/shared-types";
import type { Env } from "../../types/ai";
import type { ProviderAdapter } from "../providers";
import {
  createProviderInferenceAdapter,
  toOpenAICompatibleBaseURL,
} from "@legioncode/execution-engine/runtime/provider/ProviderInferenceFactory";
export { toOpenAICompatibleBaseURL } from "@legioncode/execution-engine/runtime/provider/ProviderInferenceFactory";
import { ValidationError } from "../../domain/errors";
import {
  createGoogleAdapter,
  createOpenAIAdapter,
} from "./ProviderAdapterFactory";
import { buildCloudflareAIRouteHeaders } from "@repo/provider-core/discovery";

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
    return createProviderInferenceAdapter({
      transport: "openai-responses",
      apiKey,
      endpoint: route.endpoint,
      providerId: route.providerId,
      defaultModel: env.DEFAULT_MODEL,
    });
  }

  if (route.transport === "anthropic-messages") {
    return createProviderInferenceAdapter({
      transport: "anthropic-messages",
      apiKey,
      endpoint: route.endpoint,
      providerId: route.providerId,
      defaultModel: env.DEFAULT_MODEL,
    });
  }

  if (route.transport === "google-generative") {
    return createGoogleAdapter(env, apiKey, route.endpoint, route.providerId);
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
