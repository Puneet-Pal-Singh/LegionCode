import type { ProviderModelTransport } from "@repo/shared-types";
import { ProviderRegistryService } from "./ProviderRegistryService";

export interface ResolvedProviderRuntimeRoute {
  readonly runtimeModelId: string;
  readonly providerTransport: ProviderModelTransport;
  readonly providerEndpoint: string;
}

/**
 * OpenAI's provider adapter uses the Responses API for every model. The
 * provider's `/models` response does not expose transport metadata, and the
 * Responses API is the common contract for text, tools, and reasoning.
 */
export function resolveProviderRuntimeRoute(
  providerId: string | undefined,
  modelId: string | undefined,
  registryService = new ProviderRegistryService(),
): ResolvedProviderRuntimeRoute | undefined {
  const provider = providerId
    ? registryService.getProvider(providerId)
    : undefined;
  if (providerId !== "openai" || !modelId?.trim() || !provider?.baseUrl) {
    return undefined;
  }
  return {
    runtimeModelId: modelId.replace(/^openai\//i, ""),
    providerTransport: "openai-responses",
    providerEndpoint: `${provider.baseUrl.replace(/\/$/, "")}/responses`,
  };
}
