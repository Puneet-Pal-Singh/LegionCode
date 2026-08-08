import {
  type BYOKModelPricing,
  type BYOKDiscoveredProviderModelsResponse,
  type ProviderId,
  type ReasoningEffort,
} from "@repo/shared-types";

const MODEL_PAGE_SIZE = 200;
const MAX_MODEL_PAGES = 50;

export interface ChatModelMetadata {
  contextWindow?: number;
  pricing?: BYOKModelPricing;
  reasoningEfforts?: readonly ReasoningEffort[];
}

export async function findDiscoveredChatModelMetadata(
  discovery: {
    getDiscoveredModels: (
      providerId: ProviderId,
      query: {
        view: "all";
        surface: "picker";
        limit: number;
        cursor?: string;
      },
    ) => Promise<BYOKDiscoveredProviderModelsResponse>;
  },
  providerId: ProviderId,
  modelId: string,
): Promise<ChatModelMetadata> {
  let cursor: string | undefined;

  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const response = await discovery.getDiscoveredModels(providerId, {
      view: "all",
      surface: "picker",
      limit: MODEL_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const model = response.models.find((candidate) => candidate.id === modelId);
    if (model) {
      return {
        ...(model.contextWindow !== undefined
          ? { contextWindow: model.contextWindow }
          : {}),
        ...(model.pricing ? { pricing: model.pricing } : {}),
        ...(model.capabilities?.reasoningEfforts
          ? { reasoningEfforts: model.capabilities.reasoningEfforts }
          : {}),
      };
    }
    if (!response.page.hasMore || !response.page.nextCursor) {
      return {};
    }
    cursor = response.page.nextCursor;
  }

  return {};
}
