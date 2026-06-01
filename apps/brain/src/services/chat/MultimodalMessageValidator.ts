import type { CoreMessage } from "ai";
import type { RunMode } from "@repo/shared-types";
import { ValidationError } from "../../domain/errors";
import {
  SUPPORTED_IMAGE_MIME_TYPES,
  isSupportedImageMimeType,
  parseImageDataUrl,
} from "./ImageMessageRedactor";

const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;

export interface MultimodalValidationResult {
  messages: CoreMessage[];
  hasImages: boolean;
  imageCount: number;
  totalImageBytes: number;
}

export function validateMultimodalMessages(
  rawMessages: unknown[] | undefined,
  mode: RunMode,
  correlationId: string,
): MultimodalValidationResult {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new ValidationError(
      "Invalid messages: expected non-empty array",
      "INVALID_MESSAGES",
      correlationId,
    );
  }

  const counters = { imageCount: 0, totalImageBytes: 0 };
  for (const message of rawMessages) {
    validateMessage(message, mode, counters, correlationId);
  }

  return {
    messages: rawMessages as CoreMessage[],
    hasImages: counters.imageCount > 0,
    imageCount: counters.imageCount,
    totalImageBytes: counters.totalImageBytes,
  };
}

function validateMessage(
  message: unknown,
  mode: RunMode,
  counters: { imageCount: number; totalImageBytes: number },
  correlationId: string,
): void {
  if (!message || typeof message !== "object") {
    throw new ValidationError(
      "Invalid message: expected object",
      "INVALID_MESSAGES",
      correlationId,
    );
  }

  const record = message as Record<string, unknown>;
  if (typeof record.role !== "string") {
    throw new ValidationError(
      "Invalid message: expected role",
      "INVALID_MESSAGES",
      correlationId,
    );
  }

  if (!Array.isArray(record.content)) {
    return;
  }

  for (const part of record.content) {
    validateContentPart(part, record.role, mode, counters, correlationId);
  }
}

function validateContentPart(
  part: unknown,
  role: string,
  mode: RunMode,
  counters: { imageCount: number; totalImageBytes: number },
  correlationId: string,
): void {
  if (!part || typeof part !== "object") {
    return;
  }

  const record = part as Record<string, unknown>;
  if (record.type !== "image") {
    return;
  }

  if (role !== "user") {
    throw new ValidationError(
      "Only user messages may include image attachments.",
      "IMAGE_ATTACHMENT_ROLE_UNSUPPORTED",
      correlationId,
    );
  }
  if (mode !== "build") {
    throw new ValidationError(
      "Image attachments are only supported in build mode.",
      "IMAGE_ATTACHMENT_MODE_UNSUPPORTED",
      correlationId,
    );
  }

  validateImagePart(record, counters, correlationId);
}

function validateImagePart(
  record: Record<string, unknown>,
  counters: { imageCount: number; totalImageBytes: number },
  correlationId: string,
): void {
  if (typeof record.image !== "string") {
    throw new ValidationError(
      "Image attachment must include a data URL.",
      "IMAGE_ATTACHMENT_DATA_URL_INVALID",
      correlationId,
    );
  }

  const mimeType = readMimeType(record);
  if (!mimeType || !isSupportedImageMimeType(mimeType)) {
    throw new ValidationError(
      `Unsupported image MIME type. Supported types: ${SUPPORTED_IMAGE_MIME_TYPES.join(", ")}.`,
      "IMAGE_ATTACHMENT_MIME_UNSUPPORTED",
      correlationId,
    );
  }

  const parsed = parseImageDataUrl(record.image);
  if (!parsed || parsed.mediaType !== mimeType) {
    throw new ValidationError(
      "Image attachment data URL is invalid or does not match mimeType.",
      "IMAGE_ATTACHMENT_DATA_URL_INVALID",
      correlationId,
    );
  }

  counters.imageCount += 1;
  counters.totalImageBytes += parsed.byteSize;
  if (counters.imageCount > MAX_IMAGES_PER_MESSAGE) {
    throw new ValidationError(
      `A message can include at most ${MAX_IMAGES_PER_MESSAGE} images.`,
      "IMAGE_ATTACHMENT_COUNT_EXCEEDED",
      correlationId,
    );
  }
  if (parsed.byteSize > MAX_IMAGE_BYTES) {
    throw new ValidationError(
      "Image attachment exceeds the per-image size limit.",
      "IMAGE_ATTACHMENT_TOO_LARGE",
      correlationId,
    );
  }
  if (counters.totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new ValidationError(
      "Image attachments exceed the total size limit.",
      "IMAGE_ATTACHMENT_TOTAL_TOO_LARGE",
      correlationId,
    );
  }
}

function readMimeType(record: Record<string, unknown>): string | null {
  if (typeof record.mimeType === "string") {
    return record.mimeType.toLowerCase();
  }
  if (typeof record.mediaType === "string") {
    return record.mediaType.toLowerCase();
  }
  return null;
}
