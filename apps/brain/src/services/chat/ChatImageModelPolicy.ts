import type { CoreMessage } from "ai";
import type {
  BYOKModelCapability,
  BYOKModelInputModality,
} from "@repo/shared-types";
import { DomainError } from "../../domain/errors";
import { messageHasImageParts } from "./ImageMessageRedactor";

export interface ChatImageModelMetadata {
  capabilities?: BYOKModelCapability;
  inputModalities?: BYOKModelInputModality;
}

export function assertChatImageModelSupport(
  metadata: ChatImageModelMetadata,
): void {
  const supported =
    metadata.inputModalities?.image ?? metadata.capabilities?.supportsVision;
  if (supported === true) return;
  throw new DomainError(
    supported === false
      ? "IMAGE_INPUT_UNSUPPORTED"
      : "IMAGE_INPUT_CAPABILITY_UNKNOWN",
    supported === false
      ? "This conversation contains images. Select a model that supports image input."
      : "Image input support could not be verified for this model. Select a model with declared image input support.",
    400,
    false,
  );
}

export function assertSubmittedImageModelSupport(
  messages: readonly CoreMessage[],
  metadata: ChatImageModelMetadata,
): void {
  if (messages.some(messageHasImageParts))
    assertChatImageModelSupport(metadata);
}
