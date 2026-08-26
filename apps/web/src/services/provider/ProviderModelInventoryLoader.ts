import type {
  ProviderModelOption,
  ProviderModelsPageResult,
  ProviderModelsQuery,
} from "../api/providerClient.js";

const COMPLETE_PICKER_PROVIDER_IDS = new Set([
  "openrouter",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
]);
const COMPLETE_PICKER_PAGE_LIMIT = 150;
const COMPLETE_PICKER_MAX_PAGES = 20;

export function shouldLoadCompletePickerInventory(input: {
  providerId: string;
  view: ProviderModelsQuery["view"];
  surface: ProviderModelsQuery["surface"];
  cursor?: string;
  append: boolean;
}): boolean {
  return (
    COMPLETE_PICKER_PROVIDER_IDS.has(input.providerId) &&
    input.view === "all" &&
    input.surface === "picker" &&
    !input.cursor &&
    !input.append
  );
}

export async function loadCompletePickerInventory(input: {
  providerId: string;
  loadPage(query: ProviderModelsQuery): Promise<ProviderModelsPageResult>;
}): Promise<ProviderModelsPageResult> {
  let cursor: string | undefined;
  let latest: ProviderModelsPageResult | null = null;
  const models = new Map<string, ProviderModelOption>();

  for (let page = 0; page < COMPLETE_PICKER_MAX_PAGES; page += 1) {
    latest = await input.loadPage({
      view: "all",
      surface: "picker",
      limit: COMPLETE_PICKER_PAGE_LIMIT,
      cursor,
    });
    latest.models.forEach((model) => models.set(model.id, model));
    cursor = latest.page.hasMore ? latest.page.nextCursor : undefined;
    if (!cursor) {
      return {
        ...latest,
        models: [...models.values()],
        page: {
          limit: COMPLETE_PICKER_PAGE_LIMIT,
          hasMore: false,
        },
      };
    }
  }

  throw new Error(
    `Model discovery for ${input.providerId} exceeded ${COMPLETE_PICKER_MAX_PAGES} pages.`,
  );
}
