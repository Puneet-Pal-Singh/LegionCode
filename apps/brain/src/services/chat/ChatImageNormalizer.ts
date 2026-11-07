import {
  normalizeChatImage as normalizeImage,
  type NormalizedImage,
} from "@repo/chat-media/normalizer";
import {
  ChatImageValidationError,
  decodeAndValidateImage as decodeImage,
  type IncomingChatImage,
} from "@repo/chat-media/validation";
import type { ChatMediaImageType } from "@repo/shared-types";
import { DomainError } from "../../domain/errors";
import type { ChatImageSettings } from "./ChatImageSettings";

export function normalizeChatImage(
  bytes: Uint8Array,
  mediaType: ChatMediaImageType,
  settings: ChatImageSettings,
): NormalizedImage {
  return withDomainError(() => normalizeImage(bytes, mediaType, settings));
}

export function decodeAndValidateImage(input: IncomingChatImage) {
  return withDomainError(() => decodeImage(input));
}

function withDomainError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ChatImageValidationError) {
      throw new DomainError(
        "IMAGE_ATTACHMENT_INVALID",
        error.message,
        400,
        false,
      );
    }
    throw error;
  }
}
