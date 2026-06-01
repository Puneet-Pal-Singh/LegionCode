import type { CoreMessage } from "ai";
import type { RunMode } from "@repo/shared-types";
import { validateMultimodalMessages } from "./MultimodalMessageValidator";

export interface ChatImageInputState {
  messages: CoreMessage[];
  hasImages: boolean;
}

export interface ChatImageInputRequest {
  messages?: unknown[];
  mode?: RunMode;
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
