import type { ProviderModelTransport } from "@repo/shared-types";
import { builtinProviderRegistry } from "./registry.js";

export interface ResolvedProviderRuntimeRoute {
  readonly runtimeModelId: string;
  readonly providerTransport: ProviderModelTransport;
  readonly providerEndpoint: string;
}

/**
 * The narrow registry surface the runtime route policy needs. Kept as a port
 * so custom registries and the builtin registry can be swapped in tests.
 */
export interface ProviderRuntimeRouteRegistry {
  getProvider(providerId: string): { baseUrl?: string } | undefined;
}

/**
 * OpenAI's provider adapter uses the Responses API for every model. The
 * provider's `/models` response does not expose transport metadata, and the
 * Responses API is the common contract for text, tools, and reasoning.
 */
export function resolveProviderRuntimeRoute(
  providerId: string | undefined,
  modelId: string | undefined,
  registry: ProviderRuntimeRouteRegistry = builtinProviderRegistry,
): ResolvedProviderRuntimeRoute | undefined {
  const provider = providerId ? registry.getProvider(providerId) : undefined;
  if (providerId !== "openai" || !modelId?.trim() || !provider?.baseUrl) {
    return undefined;
  }
  return {
    runtimeModelId: modelId.replace(/^openai\//i, ""),
    providerTransport: "openai-responses",
    providerEndpoint: `${provider.baseUrl.replace(/\/$/, "")}/responses`,
  };
}
