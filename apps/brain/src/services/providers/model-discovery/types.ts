import type {
  BYOKDiscoveredProviderModel,
  BYOKModelDiscoverySource,
  BYOKModelDiscoveryView,
  ProviderConnectionConfig,
} from "@repo/shared-types";

export interface ProviderModelCredentialContext {
  userId?: string;
  workspaceId?: string;
  apiKey: string;
  connectionConfig?: ProviderConnectionConfig;
}

export interface ProviderModelFetchPageInput {
  providerId: string;
  cursor?: string;
  limit: number;
  credentialContext: ProviderModelCredentialContext;
}

export interface ProviderModelPageFetchResult {
  providerId: string;
  models: BYOKDiscoveredProviderModel[];
  nextCursor?: string;
  fetchedAt: string;
  source: BYOKModelDiscoverySource;
}

export interface ProviderModelCacheGetInput {
  providerId: string;
  workspaceId: string;
}

export interface ProviderModelCacheSetInput {
  providerId: string;
  workspaceId: string;
  payload: ProviderModelPageFetchResult;
  expiresAt: string;
}

export interface ProviderModelCacheEntry {
  providerId: string;
  workspaceId: string;
  payload: ProviderModelPageFetchResult;
  fetchedAt: string;
  expiresAt: string;
}

export interface ProviderModelRankingSignals {
  modelSelectionFrequency: Record<string, number>;
  successfulRunFrequency: Record<string, number>;
  providerDeclaredBoost: Record<string, number>;
  capabilityFit: Record<string, number>;
  costEfficiency: Record<string, number>;
}

export interface ProviderModelRankingInput {
  providerId: string;
  models: BYOKDiscoveredProviderModel[];
  signals: ProviderModelRankingSignals;
  limit: number;
}

export interface ProviderModelRankingResult {
  providerId: string;
  view: BYOKModelDiscoveryView;
  models: BYOKDiscoveredProviderModel[];
}

export interface OpenRouterRecommendationInput {
  userModels: BYOKDiscoveredProviderModel[];
  programmingModels: BYOKDiscoveredProviderModel[];
  limit: number;
}

export const OPENROUTER_DISCOVERY_CATEGORIES = [
  "programming",
  "technology",
  "science",
  "academia",
] as const;

export type OpenRouterDiscoveryCategory =
  (typeof OPENROUTER_DISCOVERY_CATEGORIES)[number];
