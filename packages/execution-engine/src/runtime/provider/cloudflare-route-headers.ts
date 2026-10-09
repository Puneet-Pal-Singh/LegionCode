import type { ProviderConnectionConfig } from "@repo/shared-types";

const DEFAULT_CLOUDFLARE_GATEWAY_ID = "default";

export function buildCloudflareAIRouteHeaders(
  config: ProviderConnectionConfig,
): Record<string, string> | undefined {
  if (
    config.providerId !== "cloudflare-ai-gateway" &&
    !(config.providerId === "cloudflare-ai" && config.routeMode === "ai-gateway")
  ) {
    return undefined;
  }

  const gatewayId = "gatewayId" in config ? config.gatewayId?.trim() : undefined;
  return {
    "cf-aig-gateway-id": gatewayId || DEFAULT_CLOUDFLARE_GATEWAY_ID,
  };
}
