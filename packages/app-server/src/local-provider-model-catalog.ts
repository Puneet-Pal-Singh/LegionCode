import type { ProviderId } from "@repo/platform-protocol";
import type {
  BYOKDiscoveredProviderModel,
  BYOKDiscoveredProviderModelsQuery,
  BYOKDiscoveredProviderModelsRefreshResponse,
  BYOKDiscoveredProviderModelsResponse,
} from "@repo/shared-types";
import { AppServerOperationError } from "./server.js";

/** The shared server-only catalog implements this port directly. No secrets. */
export interface LocalProviderModelCatalog {
  getDiscoveredModels(
    providerId: string,
    query: BYOKDiscoveredProviderModelsQuery,
  ): Promise<BYOKDiscoveredProviderModelsResponse>;
  refreshDiscoveredModels(providerId: string): Promise<BYOKDiscoveredProviderModelsRefreshResponse>;
}

const EXACT_MODEL_PAGE_LIMIT = 200;
const EXACT_MODEL_MAX_PAGES = 20;

/** Request-local inventory only; the injected discovery service owns caching. */
export async function readLocalProviderModelInventory(
  providerId: ProviderId,
  loadPage: (query: BYOKDiscoveredProviderModelsQuery) => Promise<BYOKDiscoveredProviderModelsResponse>,
): Promise<ReadonlyMap<string, BYOKDiscoveredProviderModel>> {
  const models = new Map<string, BYOKDiscoveredProviderModel>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < EXACT_MODEL_MAX_PAGES; page += 1) {
    const response = await loadPage({ view: "all", surface: "manage", limit: EXACT_MODEL_PAGE_LIMIT, cursor });
    if (response.metadata.status !== "available")
      throw modelCatalogUnavailable("Provider model discovery is unavailable.");
    if (response.models.length > EXACT_MODEL_PAGE_LIMIT)
      throw modelCatalogUnavailable("Provider model discovery exceeded its page budget.");
    response.models.forEach((model) => models.set(model.id, model));
    if (!response.page.hasMore) return models;
    const next = response.page.nextCursor;
    if (!next || seenCursors.has(next))
      throw modelCatalogUnavailable("Provider model discovery returned an invalid continuation.");
    seenCursors.add(next);
    cursor = next;
  }
  throw modelCatalogUnavailable(`Provider model discovery for ${providerId} exceeded its page budget.`);
}

export function modelCatalogUnavailable(message: string): AppServerOperationError {
  return new AppServerOperationError(503, "server_unavailable", message, "local_provider_discovery_unavailable", true);
}
