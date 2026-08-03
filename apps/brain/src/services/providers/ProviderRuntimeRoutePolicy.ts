import type { ProviderModelTransport } from "@repo/shared-types";

export interface ResolvedProviderRuntimeRoute {
  readonly runtimeModelId: string;
  readonly providerTransport: ProviderModelTransport;
  readonly providerEndpoint: string;
}

/**
 * Resolves provider-owned transport requirements that are not exposed by the
 * provider's `/models` response. OpenAI's reasoning model families use the
 * Responses API so tool calls and reasoning share one supported contract.
 */
export function resolveProviderRuntimeRoute(
  providerId: string | undefined,
  modelId: string | undefined,
): ResolvedProviderRuntimeRoute | undefined {
  if (providerId !== "openai" || !modelId || !usesOpenAIResponses(modelId)) {
    return undefined;
  }
  return {
    runtimeModelId: modelId,
    providerTransport: "openai-responses",
    providerEndpoint: "https://api.openai.com/v1/responses",
  };
}

function usesOpenAIResponses(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return /^(?:gpt-5(?:[.-]|$)|o[1-9](?:[.-]|$))/.test(normalized);
}
