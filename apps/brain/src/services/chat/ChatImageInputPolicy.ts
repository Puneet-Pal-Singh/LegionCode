import type { CoreMessage } from "ai";
import { validateMultimodalMessages } from "./MultimodalMessageValidator";

export interface ChatImageInputState {
  messages: CoreMessage[];
}

export interface ChatImageInputRequest {
  messages?: unknown[];
}

export function validateChatImageInput(
  request: ChatImageInputRequest,
  correlationId: string,
): ChatImageInputState {
  const validation = validateMultimodalMessages(
    request.messages,
    correlationId,
  );
  return {
    messages: validation.messages,
  };
}
