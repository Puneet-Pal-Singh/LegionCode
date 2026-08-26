import type {
  CloudflareAIGatewayConnectionConfig,
  CloudflareAIConnectionConfig,
  CloudflareWorkersAIConnectionConfig,
  ProviderModelTransport,
} from "@repo/shared-types";
import { ProviderModelDiscoveryApiError } from "../model-discovery/errors";

export interface CloudflareAIRouteInput {
  config: CloudflareConnectionConfig;
  modelId: string;
  transport: ProviderModelTransport;
}

const DEFAULT_CLOUDFLARE_GATEWAY_ID = "default";

export type CloudflareConnectionConfig =
  | CloudflareAIConnectionConfig
  | CloudflareWorkersAIConnectionConfig
  | CloudflareAIGatewayConnectionConfig;

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
  _config: CloudflareConnectionConfig,
  modelId: string,
): string {
  return modelId;
}

export function buildCloudflareAIRouteHeaders(
  config: CloudflareConnectionConfig,
): Record<string, string> | undefined {
  if (
    config.providerId !== "cloudflare-ai-gateway" &&
    !(config.providerId === "cloudflare-ai" && config.routeMode === "ai-gateway")
  ) {
    return undefined;
  }
  return {
    "cf-aig-gateway-id": resolveCloudflareGatewayId(config),
  };
}

function resolveCloudflareGatewayId(
  config: CloudflareConnectionConfig,
): string {
  const gatewayId =
    config.providerId === "cloudflare-workers-ai"
      ? undefined
      : config.gatewayId?.trim();
  return gatewayId && gatewayId.length > 0
    ? gatewayId
    : DEFAULT_CLOUDFLARE_GATEWAY_ID;
}
