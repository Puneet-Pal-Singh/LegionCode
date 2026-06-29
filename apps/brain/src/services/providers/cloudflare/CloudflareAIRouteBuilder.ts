import type {
  CloudflareAIConnectionConfig,
  ProviderModelTransport,
} from "@repo/shared-types";
import { ProviderModelDiscoveryApiError } from "../model-discovery/errors";

export interface CloudflareAIRouteInput {
  config: CloudflareAIConnectionConfig;
  modelId: string;
  transport: ProviderModelTransport;
}

const DEFAULT_CLOUDFLARE_GATEWAY_ID = "default";
const WORKERS_AI_GATEWAY_MODEL_PREFIX = "workers-ai/";

export function buildCloudflareAIRoute(input: CloudflareAIRouteInput): string {
  if (input.transport !== "openai-chat-completions") {
    throw new ProviderModelDiscoveryApiError(
      `Cloudflare AI transport "${input.transport}" is not wired yet.`,
      { status: 400, retryable: false },
    );
  }
  if (input.config.routeMode === "workers-ai-direct") {
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.config.accountId)}/ai/v1/chat/completions`;
  }
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(input.config.accountId)}/${encodeURIComponent(resolveCloudflareGatewayId(input.config))}/compat/chat/completions`;
}

export function resolveCloudflareRuntimeModelId(
  config: CloudflareAIConnectionConfig,
  modelId: string,
): string {
  if (config.routeMode === "workers-ai-direct") {
    return modelId;
  }
  if (modelId.startsWith(WORKERS_AI_GATEWAY_MODEL_PREFIX)) {
    return modelId;
  }
  return `${WORKERS_AI_GATEWAY_MODEL_PREFIX}${modelId}`;
}

function resolveCloudflareGatewayId(
  config: CloudflareAIConnectionConfig,
): string {
  const gatewayId = config.gatewayId?.trim();
  return gatewayId && gatewayId.length > 0
    ? gatewayId
    : DEFAULT_CLOUDFLARE_GATEWAY_ID;
}
