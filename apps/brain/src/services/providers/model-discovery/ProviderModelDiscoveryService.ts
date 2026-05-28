import type {
  BYOKDiscoveredProviderModel,
  BYOKDiscoveredProviderModelsQuery,
  BYOKDiscoveredProviderModelsRefreshResponse,
  BYOKDiscoveredProviderModelsResponse,
  ProviderRegistryEntry,
} from "@repo/shared-types";
import type {
  ProviderModelCacheStore,
  ProviderModelCacheRecord,
} from "../stores/ProviderModelCacheStore";
import type { ProviderCredentialService } from "../ProviderCredentialService";
import { ProviderRegistryService } from "../ProviderRegistryService";
import {
  ProviderModelCacheError,
  ProviderModelDiscoveryAuthError,
  ProviderModelDiscoveryApiError,
} from "./errors";
import type {
  ProviderModelCatalogPort,
  OpenRouterModelCatalogPort,
} from "./ProviderModelCatalogPort";
import { OpenRouterModelCatalogAdapter } from "./adapters/OpenRouterModelCatalogAdapter";
import { GoogleModelCatalogAdapter } from "./adapters/GoogleModelCatalogAdapter";
import { OpenAICompatibleModelCatalogAdapter } from "./adapters/OpenAICompatibleModelCatalogAdapter";
import { OpenCodeGoModelCatalogAdapter } from "./adapters/OpenCodeGoModelCatalogAdapter";
import { ProviderModelRankingService } from "./ProviderModelRankingService";
import { ProviderModelDiscoveryObservability } from "./ProviderModelDiscoveryObservability";
import type { OpenRouterRecommendationInput } from "./types";
import {
  OPENROUTER_DISCOVERY_CATEGORIES,
  type OpenRouterDiscoveryCategory,
} from "./types";

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const OPENROUTER_RECOMMENDED_MAX = 10;
const OPENROUTER_MANAGE_MODELS_MAX = 150;
const OPENROUTER_TOP_FREE_MAX = 10;
const OPENROUTER_AUTO_MODEL_ID = "openrouter/auto";
const OPENROUTER_AUTO_MODEL_NAME = "Auto (Best Model)";
const OPENROUTER_PROGRAMMING_CACHE_KEY = "openrouter:programming";
const OPENROUTER_LEADERBOARD_CACHE_KEY = "openrouter:leaderboard";
const OPENROUTER_FREE_CACHE_KEY = "openrouter:free";

export class ProviderModelDiscoveryService {
  private readonly adapters: Map<string, ProviderModelCatalogPort>;
  private readonly rankingService: ProviderModelRankingService;
  private readonly observability: ProviderModelDiscoveryObservability;
  private readonly registryService: ProviderRegistryService;

  constructor(
    private readonly cacheStore: ProviderModelCacheStore,
    private readonly credentialService: ProviderCredentialService,
    registryOrAdapters?:
      | ProviderRegistryService
      | Partial<Record<string, ProviderModelCatalogPort>>,
    adaptersOrRanking?:
      | Partial<Record<string, ProviderModelCatalogPort>>
      | ProviderModelRankingService,
    rankingOrObservability?:
      | ProviderModelRankingService
      | ProviderModelDiscoveryObservability,
    maybeObservability?: ProviderModelDiscoveryObservability,
  ) {
    const { registryService, adapters, rankingService, observability } =
      resolveConstructorArgs(
        registryOrAdapters,
        adaptersOrRanking,
        rankingOrObservability,
        maybeObservability,
      );

    this.registryService = registryService;
    this.adapters = buildAdapterRegistry(this.registryService, adapters);
    this.rankingService = rankingService;
    this.observability = observability;
  }

  async getOpenRouterModels(
    query: BYOKDiscoveredProviderModelsQuery,
  ): Promise<BYOKDiscoveredProviderModelsResponse> {
    return this.getDiscoveredModels("openrouter", query);
  }

  async refreshOpenRouterModels(): Promise<BYOKDiscoveredProviderModelsRefreshResponse> {
    return this.refreshDiscoveredModels("openrouter");
  }

  async getOpenRouterUserModels(): Promise<BYOKDiscoveredProviderModel[]> {
    const credential = await this.getProviderCredential("openrouter");
    const userInventory = await this.getOpenRouterUserInventory(
      credential.cacheKey,
      credential.apiKey,
    );
    return userInventory.models;
  }

  async getDiscoveredModels(
    providerId: string,
    query: BYOKDiscoveredProviderModelsQuery,
  ): Promise<BYOKDiscoveredProviderModelsResponse> {
    const startedAt = Date.now();
    try {
      if (providerId === "openrouter" && query.view === "popular") {
        const response = await this.getOpenRouterRecommendedModels(query);
        this.observability.recordRequest({
          providerId,
          source: response.metadata.source,
          stale: response.metadata.stale,
          success: true,
          latencyMs: Date.now() - startedAt,
        });
        return response;
      }

      if (
        providerId === "openrouter" &&
        query.view === "all" &&
        query.surface === "manage"
      ) {
        const response = await this.getOpenRouterManageModels(query);
        this.observability.recordRequest({
          providerId,
          source: response.metadata.source,
          stale: response.metadata.stale,
          success: true,
          latencyMs: Date.now() - startedAt,
        });
        return response;
      }

      const fullList = await this.getCatalogWithCache(providerId);
      const surfaceModels = filterModelsForSurface(
        fullList.models,
        query.surface,
      );
      const ranked = await this.rankModels(
        providerId,
        query.view,
        surfaceModels,
        query.limit,
      );
      const page = toPage(ranked, query.cursor, query.limit);
      const stale =
        fullList.source === "cache" && isExpired(fullList.expiresAt);
      const response: BYOKDiscoveredProviderModelsResponse = {
        providerId,
        view: query.view,
        models: page.models,
        page: {
          limit: query.limit,
          cursor: query.cursor,
          nextCursor: page.nextCursor,
          hasMore: page.nextCursor !== undefined,
        },
        metadata: {
          fetchedAt: fullList.fetchedAt,
          stale,
          source: fullList.source,
          staleReason: fullList.staleReason,
        },
      };
      this.observability.recordRequest({
        providerId,
        source: response.metadata.source,
        stale: response.metadata.stale,
        success: true,
        latencyMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      this.observability.recordRequest({
        providerId,
        source: "provider_api",
        stale: false,
        success: false,
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async refreshDiscoveredModels(
    providerId: string,
  ): Promise<BYOKDiscoveredProviderModelsRefreshResponse> {
    await this.cacheStore.invalidateModelCache(providerId);
    if (providerId === "openrouter") {
      await this.invalidateCurrentOpenRouterUserInventoryCache();
      await this.invalidateOpenRouterSharedCaches();
    }
    const fresh = await this.fetchAndCacheModels(providerId);
    return {
      providerId,
      refreshedAt: fresh.fetchedAt,
      source: "provider_api",
      cacheInvalidated: true,
      modelsCount: fresh.models.length,
    };
  }

  getObservabilityMetrics() {
    return this.observability.getMetrics();
  }

  getObservabilityAlerts() {
    return this.observability.getAlerts();
  }

  private async rankModels(
    providerId: string,
    view: BYOKDiscoveredProviderModelsQuery["view"],
    models: ProviderModelCacheRecord["models"],
    limit: number,
  ) {
    if (view !== "popular") {
      return models;
    }
    const signals = buildDefaultSignals(models.map((model) => model.id));
    const ranked = await this.rankingService.computePopular({
      providerId,
      models,
      signals,
      limit: 50,
    });
    return ranked.models;
  }

  private async rankOpenRouterRecommendations(
    input: OpenRouterRecommendationInput,
  ): Promise<ProviderModelCacheRecord["models"]> {
    const programmingKeys = new Set(
      input.programmingModels.flatMap((model) => getOpenRouterMatchKeys(model)),
    );
    const intersected = input.userModels.filter((model) =>
      getOpenRouterMatchKeys(model).some((key) => programmingKeys.has(key)),
    );
    const scored = intersected.map((model) => ({
      model,
      score: computeOpenRouterRecommendationScore(model),
    }));
    const sorted = scored.sort(compareOpenRouterRecommendationScore);
    const topModels = sorted.slice(0, input.limit).map((s) => s.model);
    const hasAuto = topModels.some(
      (model) => model.id === OPENROUTER_AUTO_MODEL_ID,
    );
    let finalModels: ProviderModelCacheRecord["models"];
    if (!hasAuto) {
      finalModels = [
        {
          id: OPENROUTER_AUTO_MODEL_ID,
          name: OPENROUTER_AUTO_MODEL_NAME,
          providerId: "openrouter",
        },
        ...topModels,
      ].slice(0, input.limit + 1) as ProviderModelCacheRecord["models"];
    } else {
      finalModels = topModels;
    }

    this.observability.recordOpenRouterRecommendation(
      input.userModels.length,
      input.programmingModels.length,
      intersected.length,
      finalModels.length,
      !hasAuto,
    );

    return finalModels;
  }

  private async getCatalogWithCache(
    providerId: string,
  ): Promise<ProviderModelCacheRecord & { staleReason?: string }> {
    const cached = await this.readCache(providerId);
    if (cached && !isExpired(cached.expiresAt)) {
      this.observability.recordCacheHit(providerId);
      return cached;
    }

    try {
      return await this.fetchAndCacheModels(providerId);
    } catch (error) {
      this.observability.recordAdapterFailure(
        providerId,
        toDiscoveryErrorCode(error),
      );
      if (cached) {
        return {
          ...cached,
          source: "cache",
          staleReason: "provider_api_unavailable",
        };
      }
      throw error;
    }
  }

  private async getOpenRouterRecommendedModels(
    query: BYOKDiscoveredProviderModelsQuery,
  ): Promise<BYOKDiscoveredProviderModelsResponse> {
    const credential = await this.getProviderCredential("openrouter");
    const [userInventory, programmingModels] = await Promise.all([
      this.getOpenRouterUserInventory(credential.cacheKey, credential.apiKey),
      this.getOpenRouterProgrammingModels(),
    ]);
    const ranked = await this.rankOpenRouterRecommendations({
      userModels: userInventory.models,
      programmingModels,
      limit: Math.max(query.limit, OPENROUTER_RECOMMENDED_MAX),
    });
    const page = toPage(ranked, query.cursor, query.limit);
    return {
      providerId: "openrouter",
      view: query.view,
      models: page.models,
      page: {
        limit: query.limit,
        cursor: query.cursor,
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== undefined,
      },
      metadata: {
        fetchedAt: userInventory.fetchedAt,
        stale: false,
        source: userInventory.source,
      },
    };
  }

  private async getOpenRouterManageModels(
    query: BYOKDiscoveredProviderModelsQuery,
  ): Promise<BYOKDiscoveredProviderModelsResponse> {
    const credential = await this.getProviderCredential("openrouter");
    const userInventory = await this.getOpenRouterUserInventory(
      credential.cacheKey,
      credential.apiKey,
    );
    const categoryFetches = OPENROUTER_DISCOVERY_CATEGORIES.map(
      async (category) =>
        [category, await this.getOpenRouterCategoryModels(category)] as const,
    );
    const [leaderboardModels, freeModels, categoryEntries] = await Promise.all([
      this.getOpenRouterLeaderboardModels(),
      this.getOpenRouterFreeModels(),
      Promise.all(categoryFetches),
    ]);
    const categoryMap = new Map(categoryEntries);

    const ordered = buildOpenRouterManageModels({
      userModels: userInventory.models,
      leaderboardModels,
      programmingModels: categoryMap.get("programming") ?? [],
      technologyModels: categoryMap.get("technology") ?? [],
      scienceModels: categoryMap.get("science") ?? [],
      academiaModels: categoryMap.get("academia") ?? [],
      freeModels,
      limit: Math.max(query.limit, OPENROUTER_MANAGE_MODELS_MAX),
    });

    const page = toPage(ordered, query.cursor, query.limit);
    return {
      providerId: "openrouter",
      view: query.view,
      models: page.models,
      page: {
        limit: query.limit,
        cursor: query.cursor,
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== undefined,
      },
      metadata: {
        fetchedAt: userInventory.fetchedAt,
        stale: false,
        source: userInventory.source,
      },
    };
  }

  private async fetchAndCacheModels(
    providerId: string,
  ): Promise<ProviderModelCacheRecord> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new ProviderModelCacheError(
        `No discovery adapter is registered for provider "${providerId}".`,
      );
    }

    let apiKey: string | null = null;
    try {
      apiKey = await this.credentialService.getApiKey(providerId);
    } catch (_error) {
      throw new ProviderModelDiscoveryAuthError(
        `Failed to read ${providerId} credentials for model discovery. Reconnect this provider and retry.`,
      );
    }
    if (!apiKey) {
      throw new ProviderModelDiscoveryAuthError(
        `${providerId} credentials are not connected for model discovery.`,
      );
    }
    const models = await adapter.fetchAll(providerId, {
      apiKey,
    });
    const fetchedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + MODEL_CACHE_TTL_MS).toISOString();
    const record: ProviderModelCacheRecord = {
      providerId,
      models,
      fetchedAt,
      expiresAt,
      source: "provider_api",
    };
    await this.cacheStore.setModelCache(record);
    return record;
  }

  private async getOpenRouterProgrammingModels(): Promise<
    BYOKDiscoveredProviderModel[]
  > {
    return this.getOpenRouterSharedModels(
      OPENROUTER_PROGRAMMING_CACHE_KEY,
      async (adapter) => adapter.fetchProgrammingModels("openrouter"),
    );
  }

  private async getOpenRouterCategoryModels(
    category: OpenRouterDiscoveryCategory,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    return this.getOpenRouterSharedModels(
      buildOpenRouterCategoryCacheKey(category),
      async (adapter) => adapter.fetchCategoryModels("openrouter", category),
    );
  }

  private async getOpenRouterLeaderboardModels(): Promise<
    BYOKDiscoveredProviderModel[]
  > {
    return this.getOpenRouterSharedModels(
      OPENROUTER_LEADERBOARD_CACHE_KEY,
      async (adapter) => adapter.fetchLeaderboardModels("openrouter"),
    );
  }

  private async getOpenRouterFreeModels(): Promise<
    BYOKDiscoveredProviderModel[]
  > {
    return this.getOpenRouterSharedModels(
      OPENROUTER_FREE_CACHE_KEY,
      async (adapter) => adapter.fetchFreeModels("openrouter"),
    );
  }

  private async getOpenRouterSharedModels(
    cacheKey: string,
    loader: (
      adapter: OpenRouterModelCatalogPort,
    ) => Promise<BYOKDiscoveredProviderModel[]>,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    const cached = await this.readCache(cacheKey);
    if (cached && !isExpired(cached.expiresAt)) {
      this.observability.recordCacheHit(cacheKey);
      return cached.models;
    }

    const adapter = this.getOpenRouterAdapter();
    const models = await loader(adapter);
    const fetchedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + MODEL_CACHE_TTL_MS).toISOString();
    const record: ProviderModelCacheRecord = {
      providerId: cacheKey,
      models,
      fetchedAt,
      expiresAt,
      source: "provider_api",
    };
    await this.cacheStore.setModelCache(record);
    return record.models;
  }

  private async getOpenRouterUserInventory(
    cacheKey: string,
    apiKey: string,
  ): Promise<ProviderModelCacheRecord> {
    const cached = await this.readUserCache({
      providerId: "openrouter",
      credentialId: cacheKey,
    });
    if (cached) {
      this.observability.recordCacheHit("openrouter");
      return cached;
    }

    const adapter = this.getOpenRouterAdapter();
    const models = await adapter.fetchUserModels("openrouter", { apiKey });
    const fetchedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + MODEL_CACHE_TTL_MS).toISOString();
    const record: ProviderModelCacheRecord = {
      providerId: "openrouter",
      models,
      fetchedAt,
      expiresAt,
      source: "provider_api",
    };
    await this.cacheStore.setUserModelCache(
      { providerId: "openrouter", credentialId: cacheKey },
      record,
    );
    return record;
  }

  private async invalidateCurrentOpenRouterUserInventoryCache(): Promise<void> {
    try {
      const credential = await this.getProviderCredential("openrouter");
      await this.cacheStore.invalidateUserModelCache({
        providerId: "openrouter",
        credentialId: credential.cacheKey,
      });
    } catch (error) {
      if (error instanceof ProviderModelDiscoveryAuthError) {
        return;
      }
      throw error;
    }
  }

  private async invalidateOpenRouterSharedCaches(): Promise<void> {
    const cacheKeys = [
      OPENROUTER_PROGRAMMING_CACHE_KEY,
      OPENROUTER_LEADERBOARD_CACHE_KEY,
      OPENROUTER_FREE_CACHE_KEY,
      ...OPENROUTER_DISCOVERY_CATEGORIES.map(buildOpenRouterCategoryCacheKey),
    ];

    await Promise.all(
      cacheKeys.map((cacheKey) =>
        this.cacheStore.invalidateModelCache(cacheKey),
      ),
    );
  }

  private async getProviderCredential(providerId: string): Promise<{
    apiKey: string;
    cacheKey: string;
  }> {
    let apiKey: string | null = null;
    try {
      apiKey = await this.credentialService.getApiKey(providerId);
    } catch (_error) {
      throw new ProviderModelDiscoveryAuthError(
        `Failed to read ${providerId} credentials for model discovery. Reconnect this provider and retry.`,
      );
    }
    if (!apiKey) {
      throw new ProviderModelDiscoveryAuthError(
        `${providerId} credentials are not connected for model discovery.`,
      );
    }
    return {
      apiKey,
      cacheKey: await buildCredentialCacheKey(providerId, apiKey),
    };
  }

  private getOpenRouterAdapter(): OpenRouterModelCatalogPort {
    const adapter = this.adapters.get("openrouter");
    if (
      !adapter ||
      typeof (adapter as OpenRouterModelCatalogPort).fetchUserModels !==
        "function"
    ) {
      throw new ProviderModelCacheError(
        "OpenRouter adapter does not support recommendation discovery.",
      );
    }
    return adapter as OpenRouterModelCatalogPort;
  }

  private async readCache(
    providerId: string,
  ): Promise<ProviderModelCacheRecord | null> {
    try {
      return await this.cacheStore.getModelCache(providerId);
    } catch (error) {
      throw new ProviderModelCacheError(
        toErrorMessage(error, "Failed to read provider model cache."),
      );
    }
  }

  private async readUserCache(key: {
    providerId: string;
    credentialId: string;
  }): Promise<ProviderModelCacheRecord | null> {
    try {
      return await this.cacheStore.getUserModelCache(key);
    } catch (error) {
      throw new ProviderModelCacheError(
        toErrorMessage(
          error,
          "Failed to read user-scoped provider model cache.",
        ),
      );
    }
  }
}

function resolveConstructorArgs(
  registryOrAdapters:
    | ProviderRegistryService
    | Partial<Record<string, ProviderModelCatalogPort>>
    | undefined,
  adaptersOrRanking:
    | Partial<Record<string, ProviderModelCatalogPort>>
    | ProviderModelRankingService
    | undefined,
  rankingOrObservability:
    | ProviderModelRankingService
    | ProviderModelDiscoveryObservability
    | undefined,
  maybeObservability: ProviderModelDiscoveryObservability | undefined,
): {
  registryService: ProviderRegistryService;
  adapters: Partial<Record<string, ProviderModelCatalogPort>>;
  rankingService: ProviderModelRankingService;
  observability: ProviderModelDiscoveryObservability;
} {
  const defaultRegistry = new ProviderRegistryService();
  const defaultRanking = new ProviderModelRankingService();
  const defaultObservability = new ProviderModelDiscoveryObservability();

  if (registryOrAdapters instanceof ProviderRegistryService) {
    return {
      registryService: registryOrAdapters,
      adapters:
        !adaptersOrRanking ||
        adaptersOrRanking instanceof ProviderModelRankingService
          ? {}
          : adaptersOrRanking,
      rankingService:
        adaptersOrRanking instanceof ProviderModelRankingService
          ? adaptersOrRanking
          : rankingOrObservability instanceof ProviderModelRankingService
            ? rankingOrObservability
            : defaultRanking,
      observability:
        rankingOrObservability instanceof ProviderModelDiscoveryObservability
          ? rankingOrObservability
          : (maybeObservability ?? defaultObservability),
    };
  }

  return {
    registryService: defaultRegistry,
    adapters: registryOrAdapters ?? {},
    rankingService:
      adaptersOrRanking instanceof ProviderModelRankingService
        ? adaptersOrRanking
        : rankingOrObservability instanceof ProviderModelRankingService
          ? rankingOrObservability
          : defaultRanking,
    observability:
      rankingOrObservability instanceof ProviderModelDiscoveryObservability
        ? rankingOrObservability
        : (maybeObservability ?? defaultObservability),
  };
}

function buildAdapterRegistry(
  registryService: ProviderRegistryService,
  provided: Partial<Record<string, ProviderModelCatalogPort>>,
): Map<string, ProviderModelCatalogPort> {
  const adapters = new Map<string, ProviderModelCatalogPort>();
  for (const provider of registryService.listProviders()) {
    const adapter =
      provided[provider.providerId] ?? createAdapterForProvider(provider);
    if (!adapter) {
      continue;
    }
    adapters.set(provider.providerId, adapter);
  }
  return adapters;
}

function createAdapterForProvider(
  provider: ProviderRegistryEntry,
): ProviderModelCatalogPort | undefined {
  if (provider.providerId === "openrouter") {
    return new OpenRouterModelCatalogAdapter();
  }

  if (provider.providerId === "opencode-go") {
    return new OpenCodeGoModelCatalogAdapter();
  }

  if (provider.adapterFamily === "google-native") {
    return new GoogleModelCatalogAdapter();
  }

  if (provider.adapterFamily === "openai-compatible") {
    const endpoint =
      provider.modelsEndpoint ??
      (provider.baseUrl
        ? `${provider.baseUrl.replace(/\/$/, "")}/models`
        : undefined);
    if (!endpoint) {
      return undefined;
    }
    return new OpenAICompatibleModelCatalogAdapter(
      provider.providerId,
      endpoint,
    );
  }

  return undefined;
}

function filterModelsForSurface(
  models: ProviderModelCacheRecord["models"],
  surface: BYOKDiscoveredProviderModelsQuery["surface"],
): ProviderModelCacheRecord["models"] {
  if (surface === "manage") {
    return models;
  }
  return models.filter((model) => {
    const availability = model.availability ?? "available";
    return availability === "available";
  });
}

function buildDefaultSignals(modelIds: string[]) {
  const signalMap: Record<string, number> = {};
  for (const modelId of modelIds) {
    signalMap[modelId] = 0;
  }
  return {
    modelSelectionFrequency: { ...signalMap },
    successfulRunFrequency: { ...signalMap },
    providerDeclaredBoost: { ...signalMap },
    capabilityFit: { ...signalMap },
    costEfficiency: { ...signalMap },
  };
}

function toPage(
  models: ProviderModelCacheRecord["models"],
  cursor: string | undefined,
  limit: number,
) {
  const offset = parseCursor(cursor);
  const nextOffset = offset + limit;
  return {
    models: models.slice(offset, nextOffset),
    nextCursor: nextOffset < models.length ? String(nextOffset) : undefined,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ProviderModelDiscoveryApiError(
      `Invalid cursor "${cursor}" for model discovery.`,
      { status: 400, retryable: false },
    );
  }
  return parsed;
}

function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() <= Date.now();
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function toDiscoveryErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "UNKNOWN";
}

function computeOpenRouterRecommendationScore(
  model: ProviderModelCacheRecord["models"][number],
): number {
  let score = 0;
  const caps = model.capabilities;

  if (caps?.supportsTools) {
    score += 30;
  }
  if (caps?.supportsStructuredOutputs) {
    score += 20;
  }
  if (caps?.supportsReasoning) {
    score += 15;
  }
  if ((model.contextWindow ?? 0) >= 128_000) {
    score += 10;
  } else if ((model.contextWindow ?? 0) >= 32_000) {
    score += 5;
  }

  const inputCost = model.pricing?.inputPer1M ?? Number.POSITIVE_INFINITY;
  if (Number.isFinite(inputCost)) {
    if (inputCost <= 1) {
      score += 10;
    } else if (inputCost <= 3) {
      score += 5;
    } else if (inputCost >= 15) {
      score -= 10;
    }
  }

  if (model.outputModalities?.text) {
    score += 5;
  }

  if (model.expirationDate) {
    const expDate = new Date(model.expirationDate);
    const daysUntilExpiry =
      (expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilExpiry < 30) {
      score -= 20;
    }
  }

  if (model.id.includes(":free")) {
    score -= 15;
  }

  return score;
}

function compareOpenRouterRecommendationScore(
  a: { model: ProviderModelCacheRecord["models"][number]; score: number },
  b: { model: ProviderModelCacheRecord["models"][number]; score: number },
): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  return a.model.id.localeCompare(b.model.id);
}

function getOpenRouterMatchKeys(model: BYOKDiscoveredProviderModel): string[] {
  const keys = [model.id.trim().toLowerCase()];
  if (model.canonicalSlug) {
    keys.push(model.canonicalSlug.trim().toLowerCase());
  }
  return Array.from(new Set(keys));
}

function buildOpenRouterCategoryCacheKey(
  category: OpenRouterDiscoveryCategory,
): string {
  return `openrouter:${category}`;
}

async function buildCredentialCacheKey(
  providerId: string,
  apiKey: string,
): Promise<string> {
  const raw = new TextEncoder().encode(`${providerId}:${apiKey}`);
  const digest = await crypto.subtle.digest("SHA-256", raw);
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${providerId}:${hash}`;
}

function buildOpenRouterManageModels(input: {
  userModels: BYOKDiscoveredProviderModel[];
  leaderboardModels: BYOKDiscoveredProviderModel[];
  programmingModels: BYOKDiscoveredProviderModel[];
  technologyModels: BYOKDiscoveredProviderModel[];
  scienceModels: BYOKDiscoveredProviderModel[];
  academiaModels: BYOKDiscoveredProviderModel[];
  freeModels: BYOKDiscoveredProviderModel[];
  limit: number;
}): BYOKDiscoveredProviderModel[] {
  const userIndex = buildOpenRouterUserInventoryIndex(input.userModels);
  const ordered: BYOKDiscoveredProviderModel[] = [];
  const seen = new Set<string>();

  const addModels = (
    models: BYOKDiscoveredProviderModel[],
    limit?: number,
  ): void => {
    let added = 0;
    for (const model of models) {
      const matched =
        model.id === OPENROUTER_AUTO_MODEL_ID
          ? model
          : resolveOpenRouterInventoryModel(userIndex, model);
      if (!matched) {
        continue;
      }
      const dedupeKey = buildOpenRouterDedupeKey(matched);
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      ordered.push(matched);
      added += 1;
      if (limit !== undefined && added >= limit) {
        return;
      }
      if (ordered.length >= input.limit) {
        return;
      }
    }
  };

  addModels([
    {
      id: OPENROUTER_AUTO_MODEL_ID,
      name: OPENROUTER_AUTO_MODEL_NAME,
      providerId: "openrouter",
    },
  ]);
  addModels(input.leaderboardModels);
  addModels(input.programmingModels);
  addModels(input.technologyModels);
  addModels(input.scienceModels);
  addModels(input.academiaModels);
  addModels(input.freeModels, OPENROUTER_TOP_FREE_MAX);
  addModels(sortOpenRouterInventoryTail(input.userModels));

  return ordered.slice(0, input.limit);
}

function buildOpenRouterUserInventoryIndex(
  models: BYOKDiscoveredProviderModel[],
): Map<string, BYOKDiscoveredProviderModel> {
  const index = new Map<string, BYOKDiscoveredProviderModel>();
  for (const model of models) {
    for (const key of getOpenRouterMatchKeys(model)) {
      index.set(key, model);
    }
  }
  return index;
}

function resolveOpenRouterInventoryModel(
  userIndex: Map<string, BYOKDiscoveredProviderModel>,
  candidate: BYOKDiscoveredProviderModel,
): BYOKDiscoveredProviderModel | null {
  for (const key of getOpenRouterMatchKeys(candidate)) {
    const matched = userIndex.get(key);
    if (matched) {
      return matched;
    }
  }
  return null;
}

function buildOpenRouterDedupeKey(model: BYOKDiscoveredProviderModel): string {
  if (model.id) {
    return `id:${model.id.trim().toLowerCase()}`;
  }
  if (model.canonicalSlug) {
    return `slug:${model.canonicalSlug.trim().toLowerCase()}`;
  }
  return `name:${model.providerId}:${model.name.trim().toLowerCase()}`;
}

function sortOpenRouterInventoryTail(
  models: BYOKDiscoveredProviderModel[],
): BYOKDiscoveredProviderModel[] {
  return [...models]
    .map((model) => ({
      model,
      score: computeOpenRouterRecommendationScore(model),
    }))
    .sort(compareOpenRouterRecommendationScore)
    .map((item) => item.model);
}
