import type { BYOKDiscoveredProviderModelsQuery } from "./types.js";
import { ProviderClientOperationError } from "./errors.js";

type InventoryPage = {
  models: Array<{ id: string }>;
  page: { limit: number; cursor?: string; nextCursor?: string; hasMore: boolean };
};
const COMPLETE_PICKER_PROVIDER_IDS = new Set([
  "openrouter", "cloudflare-ai-gateway", "cloudflare-workers-ai",
]);
export const PROVIDER_MODEL_CACHE_MAX_AGE_MS = 60 * 60 * 1_000;
const COMPLETE_PICKER_PAGE_LIMIT = 150;
const COMPLETE_PICKER_MAX_PAGES = 20;

export function shouldLoadCompletePickerInventory(input: {
  providerId: string;
  view: BYOKDiscoveredProviderModelsQuery["view"] | undefined;
  surface: BYOKDiscoveredProviderModelsQuery["surface"] | undefined;
  cursor?: string;
  append: boolean;
}): boolean {
  return COMPLETE_PICKER_PROVIDER_IDS.has(input.providerId) &&
    input.view === "all" && input.surface === "picker" && !input.cursor && !input.append;
}

/** One browser-safe page walker. Transport, scope and credential lifetime stay injected. */
async function loadInventory<Page extends InventoryPage>(input: {
  providerId: string;
  surface: BYOKDiscoveredProviderModelsQuery["surface"];
  limit: number;
  maxPages?: number;
  duplicatePolicy: "first" | "last";
  loadPage(query: BYOKDiscoveredProviderModelsQuery): Promise<Page>;
}): Promise<Page> {
  let cursor: string | undefined;
  const models = new Map<string, Page["models"][number]>();
  const cursors = new Set<string>();
  let firstModels: Array<Page["models"][number]> = [];
  for (let page = 0; page < (input.maxPages ?? Infinity); page += 1) {
    const latest = await input.loadPage({ view: "all", surface: input.surface, limit: input.limit, cursor });
    if (input.duplicatePolicy === "first") {
      if (firstModels.length === 0) firstModels = [...latest.models];
      else {
        const known = new Set(firstModels.map((model) => model.id));
        for (const model of latest.models) {
          if (known.has(model.id)) continue;
          known.add(model.id);
          firstModels.push(model);
        }
      }
    } else for (const model of latest.models) models.set(model.id, model);
    if (latest.page.hasMore && !latest.page.nextCursor)
      throw new Error(`Model discovery for ${input.providerId} did not provide its continuation cursor.`);
    cursor = latest.page.hasMore ? latest.page.nextCursor : undefined;
    if (!cursor) return {
      ...latest,
      models: input.duplicatePolicy === "first" ? firstModels : [...models.values()],
      page: { limit: input.limit, hasMore: false },
    };
    if (cursors.has(cursor)) throw new Error(`Model discovery for ${input.providerId} repeated its page cursor.`);
    cursors.add(cursor);
  }
  throw new Error(`Model discovery for ${input.providerId} exceeded ${input.maxPages} pages.`);
}

/** Existing complete-picker behavior, including its 20-page bound. */
export function loadCompletePickerInventory<Page extends InventoryPage>(input: {
  providerId: string;
  loadPage(query: BYOKDiscoveredProviderModelsQuery): Promise<Page>;
}): Promise<Page> {
  return loadInventory({ ...input, surface: "picker", limit: COMPLETE_PICKER_PAGE_LIMIT,
    maxPages: COMPLETE_PICKER_MAX_PAGES, duplicatePolicy: "last" });
}

/** Existing Manage behavior: all pages, first occurrence of each model wins. */
export function loadManageProviderModelInventory<Page extends InventoryPage>(input: {
  providerId: string;
  limit?: number;
  loadPage(query: BYOKDiscoveredProviderModelsQuery): Promise<Page>;
}): Promise<Page> {
  return loadInventory({ ...input, surface: "manage", limit: input.limit ?? 150, duplicatePolicy: "first" });
}

/** Reuse Web's curated model hydration without changing visibility or selection. */
export function includeManagedPickerModels<Model extends { id: string }>(
  picker: readonly Model[],
  managed: readonly Model[],
  visibleIds: ReadonlySet<string> | undefined,
  selectedModelId?: string,
): Model[] {
  const models = [...picker];
  const known = new Set(models.map((model) => model.id));
  for (const model of managed) {
    if ((!visibleIds?.has(model.id) && model.id !== selectedModelId) || known.has(model.id)) continue;
    known.add(model.id);
    models.push(model);
  }
  return models;
}

/** A successful metadata response may explicitly report discovery unavailable. */
export function assertProviderModelDiscoveryAvailable(page: {
  providerId: string;
  metadata: { status?: "available" | "unavailable"; statusReason?: string };
}): void {
  if (page.metadata.status !== "unavailable") return;
  throw new ProviderClientOperationError(
    "API_ERROR",
    `Model discovery for ${page.providerId} is unavailable${page.metadata.statusReason ? ` (${page.metadata.statusReason})` : ""}.`,
    false,
  );
}
