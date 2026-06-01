import type { ProviderId } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { PolicyError } from "../../domain/errors";
import { createPostgresProviderConfigService } from "../providers/stores/PostgresStoreFactory";

export interface ImageCapabilityGateInput {
  env: Env;
  userId?: string;
  workspaceId?: string;
  providerId?: string;
  modelId?: string;
  hasImages: boolean;
  correlationId: string;
}

export async function enforceImageCapability(
  input: ImageCapabilityGateInput,
): Promise<void> {
  if (!input.hasImages) {
    return;
  }

  if (!input.providerId || !input.modelId || !input.userId || !input.workspaceId) {
    throw unknownCapability(input.correlationId);
  }

  const service = createPostgresProviderConfigService(
    input.env,
    input.userId,
    input.workspaceId,
  );
  const response = await service.getDiscoveredModels(input.providerId as ProviderId, {
    view: "all",
    surface: "picker",
    limit: 200,
  });
  const model = response.models.find((candidate) => candidate.id === input.modelId);
  if (!model || !model.capabilityMetadata) {
    throw unknownCapability(input.correlationId);
  }
  if (model.capabilityMetadata.confidence === "unknown") {
    throw unknownCapability(input.correlationId);
  }
  if (model.inputModalities?.image !== true) {
    throw new PolicyError(
      "Selected model only allows text. Choose a vision-capable model to attach images.",
      "MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT",
      input.correlationId,
    );
  }
}

function unknownCapability(correlationId: string): PolicyError {
  return new PolicyError(
    "Selected model image capability is unknown. Refresh model metadata or choose a known vision-capable model.",
    "MODEL_IMAGE_CAPABILITY_UNKNOWN",
    correlationId,
  );
}
