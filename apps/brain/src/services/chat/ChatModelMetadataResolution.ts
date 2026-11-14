import { ProviderIdSchema } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { createPostgresProviderConfigService } from "../providers/stores/PostgresStoreFactory";
import {
  findDiscoveredChatModelMetadata,
  projectChatModelMetadata,
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

/** Native admission must not start demand-driven provider discovery. */
export async function resolveCachedChatModelMetadata(input: {
  providerId?: string;
  modelId?: string;
  readCachedModel: (providerId: string, modelId: string) => Promise<import("@repo/shared-types").BYOKDiscoveredProviderModel | null>;
}): Promise<ChatModelMetadata> {
  try {
    const providerId = ProviderIdSchema.parse(input.providerId);
    const modelId = input.modelId?.trim();
    if (!modelId) return {};
    const model = await input.readCachedModel(providerId, modelId);
    return model ? projectChatModelMetadata(model) : {};
  } catch {
    console.warn("[chat/model-metadata] cached metadata unavailable");
    return {};
  }
}

/** Both admission consumers read the same protected cache without discovery. */
export function resolveAdmissionChatModelMetadata(
  env: Env,
  scope: { userId: string; workspaceId: string; runId: string },
  selection: { providerId?: string; modelId?: string },
): Promise<ChatModelMetadata> {
  return resolveCachedChatModelMetadata({
    ...selection,
    readCachedModel: (providerId, modelId) => createPostgresProviderConfigService(
      env, scope.userId, scope.workspaceId, scope.runId,
    ).getCachedModel(providerId, modelId),
  });
}
