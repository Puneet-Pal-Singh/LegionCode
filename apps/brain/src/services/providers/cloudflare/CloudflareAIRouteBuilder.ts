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

export function buildCloudflareAIRoute(input: CloudflareAIRouteInput): string {
  if (input.transport !== "openai-chat-completions") {
    throw new ProviderModelDiscoveryApiError(
      `Cloudflare AI transport "${input.transport}" is not wired yet.`,
      { status: 400, retryable: false },
    );
  }
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.config.accountId)}/ai/v1/chat/completions`;
}

export function resolveCloudflareRuntimeModelId(
  _config: CloudflareAIConnectionConfig,
  modelId: string,
): string {
  return modelId;
}

export function buildCloudflareAIRouteHeaders(
  config: CloudflareAIConnectionConfig,
): Record<string, string> | undefined {
  if (config.routeMode !== "ai-gateway") {
    return undefined;
  }
  return {
    "cf-aig-gateway-id": resolveCloudflareGatewayId(config),
  };
}

function resolveCloudflareGatewayId(
  config: CloudflareAIConnectionConfig,
): string {
  const gatewayId = config.gatewayId?.trim();
  return gatewayId && gatewayId.length > 0
    ? gatewayId
    : DEFAULT_CLOUDFLARE_GATEWAY_ID;
}
