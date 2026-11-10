import type {
  BYOKDiscoveredProviderModel,
  ProviderConnectionConfig,
  ProviderRegistryEntry,
} from "@repo/shared-types";

/** Server-only credential delivery. One result binds the key and its config. */
export interface ProviderModelCredentialPort {
  resolveCredential(providerId: string): Promise<{
    apiKey: string;
    connectionConfig?: ProviderConnectionConfig;
  } | null>;
}

/** Existing registry metadata, independent of hosted execution profiles. */
export interface ProviderModelRegistryPort {
  listProviders(): ProviderRegistryEntry[];
  getProvider(providerId: string): ProviderRegistryEntry | undefined;
}

/** Hosted composition injects platform-managed models; local hosts omit it. */
export interface PlatformProviderModelsPort {
  getModels(providerId: string): BYOKDiscoveredProviderModel[] | undefined;
}
