/**
 * ProviderCatalogService
 * Single Responsibility: Build provider catalog and provider model lists from
 * registry + dynamic discovery authority.
 */

import type {
  BYOKDiscoveredProviderModelsResponse,
  BYOKDiscoveredProviderModelsQuery,
  BYOKDiscoveredProviderModelsRefreshResponse,
  ProviderCatalogEntry,
  ProviderCatalogResponse,
  ProviderRegistryEntry,
} from "@repo/shared-types";
import type { ModelsListResponse } from "../../schemas/provider";
import { ProviderRegistryService } from "./ProviderRegistryService";
import { ProviderModelDiscoveryService } from "./model-discovery";
import {
  ProviderModelDiscoveryApiError,
  ProviderModelDiscoveryAuthError,
  ProviderModelCacheError,
  ProviderModelNormalizationError,
} from "./model-discovery/errors";
import {
  AXIS_PROVIDER_ID,
  getAxisCatalogModels,
  getAxisDiscoveredModels,
} from "./axis";

const MODELS_DISCOVERY_QUERY: BYOKDiscoveredProviderModelsQuery = {
  view: "all",
  surface: "picker",
  limit: 200,
};

const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;

type ProviderCatalogVisibilityResolver = (
  provider: ProviderRegistryEntry,
) => Promise<boolean>;

export class ProviderCatalogService {
  constructor(
    private readonly registryService: ProviderRegistryService,
    private readonly modelDiscoveryService: ProviderModelDiscoveryService,
    private readonly canExposeProvider: ProviderCatalogVisibilityResolver = async () =>
      true,
  ) {}

  async getCatalog(): Promise<ProviderCatalogResponse> {
    const registryProviders = this.registryService.listLaunchVisibleProviders();
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

  async getModels(providerId: string): Promise<ModelsListResponse> {
    const discovered = await this.getDiscoveredModels(
      providerId,
      MODELS_DISCOVERY_QUERY,
    );
    return toModelsListResponse(discovered);
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

    if (providerId === AXIS_PROVIDER_ID) {
      return createRegistryResponse(
        providerId,
        query,
        getAxisCatalogModels().map((model) => ({
          id: model.id,
          name: model.name,
          providerId,
          contextWindow: model.contextWindow,
          description: model.description,
        })),
      );
    }

    if (provider.modelSource === "static") {
      const defaultModelId = provider.defaultModelId;
      return createRegistryResponse(
        providerId,
        query,
        defaultModelId
          ? [
              {
                id: defaultModelId,
                name: defaultModelId,
                providerId,
              },
            ]
          : [],
      );
    }

    try {
      const discovered = await withTimeout(
        this.modelDiscoveryService.getDiscoveredModels(providerId, query),
        MODEL_DISCOVERY_TIMEOUT_MS,
      );
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
    if (providerId === AXIS_PROVIDER_ID) {
      return {
        providerId: AXIS_PROVIDER_ID,
        refreshedAt: new Date().toISOString(),
        source: "provider_api",
        cacheInvalidated: false,
        modelsCount: getAxisDiscoveredModels().length,
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

function toModelsListResponse(
  discovered: BYOKDiscoveredProviderModelsResponse,
): ModelsListResponse {
  return {
    providerId: discovered.providerId,
    models: discovered.models.map((model) => ({
      id: model.id,
      name: model.name,
      provider: discovered.providerId,
      contextWindow: model.contextWindow,
      description: model.description,
    })),
    lastFetchedAt: discovered.metadata.fetchedAt,
  };
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
      stale: true,
      source: "cache",
      staleReason: "provider_api_unavailable",
      status: "unavailable",
      statusReason,
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new ProviderModelDiscoveryApiError(
            "Provider model discovery timed out.",
            { status: 504, retryable: true },
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
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
