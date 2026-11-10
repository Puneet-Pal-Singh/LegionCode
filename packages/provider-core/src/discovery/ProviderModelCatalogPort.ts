import type { BYOKDiscoveredProviderModel } from "@repo/shared-types";
import type {
  OpenRouterDiscoveryCategory,
  ProviderModelCredentialContext,
  ProviderModelFetchPageInput,
  ProviderModelPageFetchResult,
} from "./types.js";

export interface ProviderModelCatalogPort {
  fetchAll(
    providerId: string,
    credentialContext: ProviderModelCredentialContext,
  ): Promise<BYOKDiscoveredProviderModel[]>;

  fetchPage(
    input: ProviderModelFetchPageInput,
  ): Promise<ProviderModelPageFetchResult>;
}

export interface OpenRouterModelCatalogPort extends ProviderModelCatalogPort {
  fetchUserModels(
    providerId: string,
    credentialContext: ProviderModelCredentialContext,
  ): Promise<BYOKDiscoveredProviderModel[]>;

  fetchProgrammingModels(
    providerId: string,
  ): Promise<BYOKDiscoveredProviderModel[]>;

  fetchCategoryModels(
    providerId: string,
    category: OpenRouterDiscoveryCategory,
  ): Promise<BYOKDiscoveredProviderModel[]>;

  fetchLeaderboardModels(
    providerId: string,
  ): Promise<BYOKDiscoveredProviderModel[]>;

  fetchFreeModels(
    providerId: string,
  ): Promise<BYOKDiscoveredProviderModel[]>;
}
