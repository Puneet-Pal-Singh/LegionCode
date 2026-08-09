import { ProviderIdSchema } from "@repo/shared-types";
import {
  findDiscoveredChatModelMetadata,
  type ChatModelMetadata,
} from "./ChatModelMetadataResolver";

export async function resolveChatModelMetadata(input: {
  providerId?: string;
  modelId?: string;
  fetchModels: Parameters<
    typeof findDiscoveredChatModelMetadata
  >[0]["getDiscoveredModels"];
}): Promise<ChatModelMetadata> {
  try {
    const providerId = ProviderIdSchema.parse(input.providerId);
    const modelId = input.modelId?.trim();
    if (!modelId) {
      return {};
    }
    return await findDiscoveredChatModelMetadata(
      { getDiscoveredModels: input.fetchModels },
      providerId,
      modelId,
    );
  } catch (error) {
    console.warn("[chat/model-metadata] unavailable", {
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
