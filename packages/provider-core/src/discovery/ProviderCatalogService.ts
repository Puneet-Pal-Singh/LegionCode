/**
 * ProviderCatalogService
 * Single Responsibility: Build provider catalog and provider model lists from
 * registry + dynamic discovery authority.
 */

import type {
  BYOKDiscoveredProviderModelsResponse,
  BYOKDiscoveredProviderModel,
  BYOKDiscoveredProviderModelsQuery,
  BYOKDiscoveredProviderModelsRefreshResponse,
  ProviderCatalogEntry,
  ProviderCatalogResponse,
  ProviderRegistryEntry,
} from "@repo/shared-types";
import { isLaunchVisibleProvider } from "@repo/shared-types";
import { builtinProviderRegistry } from "../registry.js";
import { ProviderModelDiscoveryService } from "./ProviderModelDiscoveryService.js";
import type { PlatformProviderModelsPort, ProviderModelRegistryPort } from "./ports.js";
import {
  ProviderModelDiscoveryApiError,
  ProviderModelDiscoveryAuthError,
  ProviderModelCacheError,
  ProviderModelNormalizationError,
} from "./errors.js";

type ProviderCatalogVisibilityResolver = (
  provider: ProviderRegistryEntry,
) => Promise<boolean>;

export class ProviderCatalogService {
  constructor(
    private readonly registryService: ProviderModelRegistryPort,
    private readonly modelDiscoveryService: ProviderModelDiscoveryService,
    private readonly canExposeProvider: ProviderCatalogVisibilityResolver = async () =>
      true,
    private readonly platformProviders?: PlatformProviderModelsPort,
  ) {}

  async getCatalog(): Promise<ProviderCatalogResponse> {
    const registryProviders = this.registryService.listProviders().filter(isLaunchVisibleProvider);
    const providers: ProviderCatalogEntry[] = [];

    for (const provider of registryProviders) {
      if (!(await this.canExposeProviderSafely(provider))) {
        continue;
      }
      providers.push({
        providerId: provider.providerId,
        displayName: provider.displayName,
        capabilities: provider.capabilities,
        models: [],
        ...(provider.defaultModelId
          ? { defaultModelId: provider.defaultModelId }
          : {}),
      });
    }

    return {
      providers,
      generatedAt: new Date().toISOString(),
    };
  }

  async getDiscoveredModels(
    providerId: string,
    query: BYOKDiscoveredProviderModelsQuery,
  ): Promise<BYOKDiscoveredProviderModelsResponse> {
    const provider = this.registryService.getProvider(providerId);
    if (!provider || !(await this.isProviderVisible(providerId))) {
      return createUnavailableResponse(
        providerId,
        query,
        "provider_unavailable",
      );
    }

    const platformModels = this.platformProviders?.getModels(providerId);
    if (platformModels) {
      const models = await this.modelDiscoveryService.enrichModels(
        providerId,
        platformModels,
      );
      return createRegistryResponse(providerId, query, models);
    }

    if (provider.modelSource === "static") {
      const declared = staticRegistryModels(provider);
      const models = declared.length > 0
        ? await this.modelDiscoveryService.enrichModels(providerId, declared)
        : [];
      return createRegistryResponse(
        providerId,
        query,
        models,
      );
    }

    try {
      const discovered =
        await this.modelDiscoveryService.getDiscoveredModels(providerId, query);
      return {
        ...discovered,
        metadata: {
          ...discovered.metadata,
          status: "available",
        },
      };
    } catch (error) {
      return createUnavailableResponse(
        providerId,
        query,
        toUnavailableReason(error),
      );
    }
  }

  async refreshDiscoveredModels(
    providerId: string,
  ): Promise<BYOKDiscoveredProviderModelsRefreshResponse> {
    const platformModels = this.platformProviders?.getModels(providerId);
    if (platformModels) {
      return {
        providerId,
        refreshedAt: new Date().toISOString(),
        source: "provider_api",
        cacheInvalidated: false,
        modelsCount: platformModels.length,
      };
    }
    const provider = this.registryService.getProvider(providerId);
    if (provider?.modelSource === "static") {
      return {
        providerId,
        refreshedAt: new Date().toISOString(),
        source: "provider_api",
        cacheInvalidated: false,
        modelsCount: staticRegistryModels(provider).length,
      };
    }
    return this.modelDiscoveryService.refreshDiscoveredModels(providerId);
  }

  private async isProviderVisible(providerId: string): Promise<boolean> {
    const provider = this.registryService.getProvider(providerId);
    if (!provider) {
      return false;
    }
    return this.canExposeProviderSafely(provider);
  }

  private async canExposeProviderSafely(
    provider: ProviderRegistryEntry,
  ): Promise<boolean> {
    try {
      return await this.canExposeProvider(provider);
    } catch (error) {
      console.warn(
        "[providers/catalog-visibility] Failed to resolve provider visibility",
        {
          providerId: provider.providerId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return false;
    }
  }
}

function staticRegistryModels(provider: ProviderRegistryEntry): BYOKDiscoveredProviderModel[] {
  const modelId = provider.defaultModelId;
  return modelId ? [{
    id: modelId,
    name: modelId,
    providerId: provider.providerId,
    contextWindow: builtinProviderRegistry.getModel(provider.providerId, modelId)?.contextWindow,
  }] : [];
}

function createRegistryResponse(
  providerId: string,
  query: BYOKDiscoveredProviderModelsQuery,
  models: BYOKDiscoveredProviderModelsResponse["models"],
): BYOKDiscoveredProviderModelsResponse {
  const now = new Date().toISOString();
  const pageModels = models.slice(0, query.limit);
  return {
    providerId,
    view: query.view,
    models: pageModels,
    page: {
      limit: query.limit,
      cursor: query.cursor,
      hasMore: pageModels.length < models.length,
    },
    metadata: {
      fetchedAt: now,
      stale: false,
      source: "registry",
      status: "available",
    },
  };
}

function createUnavailableResponse(
  providerId: string,
  query: BYOKDiscoveredProviderModelsQuery,
  statusReason: BYOKDiscoveredProviderModelsResponse["metadata"]["statusReason"],
): BYOKDiscoveredProviderModelsResponse {
  return {
    providerId,
    view: query.view,
    models: [],
    page: {
      limit: query.limit,
      cursor: query.cursor,
      hasMore: false,
    },
    metadata: {
      fetchedAt: new Date().toISOString(),
      stale: false,
      source: "cache",
      status: "unavailable",
      statusReason,
    },
  };
}

function toUnavailableReason(
  error: unknown,
): BYOKDiscoveredProviderModelsResponse["metadata"]["statusReason"] {
  if (error instanceof ProviderModelDiscoveryAuthError) {
    return "not_connected";
  }
  if (error instanceof ProviderModelCacheError) {
    return "cache_unavailable";
  }
  if (error instanceof ProviderModelNormalizationError) {
    return "invalid_response";
  }
  if (error instanceof ProviderModelDiscoveryApiError && error.status === 504) {
    return "timeout";
  }
  return "provider_unavailable";
}
