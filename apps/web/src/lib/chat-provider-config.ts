type ProviderConfigResolutionSource =
  | "store_selection"
  | "provider_resolve_api";

interface ProviderConfigFields {
  providerId?: string | null;
  modelId?: string | null;
  credentialId?: string | null;
}

export interface ResolvedProviderConfig {
  providerId: string;
  modelId: string;
  credentialId: string;
  source: ProviderConfigResolutionSource;
}

export function resolveSelectedProviderConfig(input: {
  selectedProviderId?: string | null;
  selectedModelId?: string | null;
  selectedCredentialId?: string | null;
  lastResolvedConfig?: ProviderConfigFields | null;
}): ResolvedProviderConfig | null {
  return (
    toProviderConfig(
      {
        providerId: input.selectedProviderId,
        modelId: input.selectedModelId,
        credentialId: input.selectedCredentialId,
      },
      "store_selection",
    ) ?? toProviderConfig(input.lastResolvedConfig, "store_selection")
  );
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

  if (!providerId || !modelId || !credentialId) {
    return null;
  }

  return {
    providerId,
    modelId,
    credentialId,
    source,
  };
}
