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
  if (!input.config.gatewayId) {
    throw new ProviderModelDiscoveryApiError(
      "Cloudflare AI Gateway route mode requires gatewayId.",
      { status: 400, retryable: false },
    );
  }
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(input.config.accountId)}/${encodeURIComponent(input.config.gatewayId)}/workers-ai/v1/chat/completions`;
}
