import type { CoreMessage } from "ai";
import type { RunMode } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { enforceImageCapability } from "./ImageCapabilityGate";
import { validateMultimodalMessages } from "./MultimodalMessageValidator";

export interface ChatImageInputState {
  messages: CoreMessage[];
  hasImages: boolean;
}

export interface ChatImageInputRequest {
  messages?: unknown[];
  mode?: RunMode;
}

export interface ChatImageInputPolicyInput {
  env: Env;
  userId?: string;
  workspaceId?: string;
  providerId?: string;
  modelId?: string;
  imageInput: ChatImageInputState;
  correlationId: string;
}

export function validateChatImageInput(
  request: ChatImageInputRequest,
  correlationId: string,
): ChatImageInputState {
  const validation = validateMultimodalMessages(
    request.messages,
    request.mode ?? "build",
    correlationId,
  );
  return {
    messages: validation.messages,
    hasImages: validation.hasImages,
  };
}

export async function enforceChatImageInputPolicy(
  input: ChatImageInputPolicyInput,
): Promise<void> {
  await enforceImageCapability({
    env: input.env,
    userId: input.userId,
    workspaceId: input.workspaceId,
    providerId: input.providerId,
    modelId: input.modelId,
    hasImages: input.imageInput.hasImages,
    correlationId: input.correlationId,
  });
}
