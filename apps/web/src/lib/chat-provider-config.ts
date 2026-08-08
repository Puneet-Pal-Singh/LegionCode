import type { BYOKModelPricing } from "@repo/shared-types";

type ProviderConfigResolutionSource =
  | "store_selection"
  | "provider_resolve_api";

interface ProviderConfigFields {
  providerId?: string | null;
  modelId?: string | null;
  credentialId?: string | null;
  contextWindow?: number;
  pricing?: BYOKModelPricing;
}

export interface ResolvedProviderConfig {
  providerId: string;
  modelId: string;
  credentialId: string;
  source: ProviderConfigResolutionSource;
  contextWindow?: number;
  pricing?: BYOKModelPricing;
}

export function resolveSelectedProviderConfig(input: {
  selectedProviderId?: string | null;
  selectedModelId?: string | null;
  selectedCredentialId?: string | null;
  selectedModelContextWindow?: number;
  selectedModelPricing?: BYOKModelPricing;
  lastResolvedConfig?: ProviderConfigFields | null;
}): ResolvedProviderConfig | null {
  const selected = toProviderConfig(
    {
      providerId: input.selectedProviderId,
      modelId: input.selectedModelId,
      credentialId: input.selectedCredentialId,
      contextWindow: input.selectedModelContextWindow,
      pricing: input.selectedModelPricing,
    },
    "store_selection",
  );
  const resolved = toProviderConfig(
    input.lastResolvedConfig,
    "store_selection",
  );

  if (!selected) {
    return resolved;
  }

  const hasSameResolvedSelection =
    resolved &&
    resolved.providerId === selected.providerId &&
    resolved.modelId === selected.modelId &&
    resolved.credentialId === selected.credentialId;

  const contextWindow =
    selected.contextWindow === undefined && hasSameResolvedSelection
      ? resolved?.contextWindow
      : undefined;
  const pricing =
    selected.pricing === undefined && hasSameResolvedSelection
      ? resolved?.pricing
      : undefined;

  return {
    ...selected,
    ...(contextWindow ? { contextWindow } : {}),
    ...(pricing ? { pricing } : {}),
  };
}

export function requireResolvedProviderConfig(
  input: ProviderConfigFields & { source: ProviderConfigResolutionSource },
): ResolvedProviderConfig {
  const config = toProviderConfig(input, input.source);
  if (!config) {
    throw new Error(
      "Provider resolution failed: missing explicit provider/model credential selection.",
    );
  }
  return config;
}

function toProviderConfig(
  input: ProviderConfigFields | null | undefined,
  source: ProviderConfigResolutionSource,
): ResolvedProviderConfig | null {
  const providerId = input?.providerId?.trim();
  const modelId = input?.modelId?.trim();
  const credentialId = input?.credentialId?.trim();
  const contextWindow = input?.contextWindow;
  const pricing = input?.pricing;

  if (!providerId || !modelId || !credentialId) {
    return null;
  }

  return {
    providerId,
    modelId,
    credentialId,
    source,
    ...(contextWindow ? { contextWindow } : {}),
    ...(pricing ? { pricing } : {}),
  };
}
