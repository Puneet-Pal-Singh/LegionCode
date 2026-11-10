import {
  CHAT_MEDIA_IMAGE_TYPES,
  type ChatMediaImageType,
} from "@repo/shared-types";

export class ChatImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatImageValidationError";
  }
}

export const CHAT_MEDIA_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/;

export interface IncomingChatImage {
  image: string;
  mimeType?: string;
  mediaType?: string;
  name?: string;
}

export function isValidChatMediaAttachmentId(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function decodeAndValidateImage(input: IncomingChatImage): {
  bytes: Uint8Array;
  mediaType: ChatMediaImageType;
} {
  if (typeof input.image !== "string") {
    throw invalidImage("Image attachment must include a data URL.");
  }
  const match = DATA_URL_PATTERN.exec(input.image);
  if (!match?.[1] || !match[2]) {
    throw invalidImage("Image attachment data URL is invalid.");
  }
  const declaredMediaType = normalizeSupportedMediaType(
    input.mimeType ?? input.mediaType ?? match[1],
  );
  if (!declaredMediaType || match[1].toLowerCase() !== declaredMediaType) {
    throw invalidImage("Image attachment MIME type is invalid.");
  }

  // Reject an oversized encoded body before allocating its decoded bytes.
  if (match[2].length > Math.ceil((CHAT_MEDIA_MAX_IMAGE_BYTES * 4) / 3) + 16) {
    throw invalidImage("Image attachment exceeds the per-image size limit.");
  }

  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    throw invalidImage("Image attachment data URL is invalid.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength === 0 || bytes.byteLength > CHAT_MEDIA_MAX_IMAGE_BYTES) {
    throw invalidImage("Image attachment exceeds the per-image size limit.");
  }

  const detectedMediaType = sniffImageMediaType(bytes);
  if (detectedMediaType !== declaredMediaType) {
    throw invalidImage("Image bytes do not match the declared MIME type.");
  }
  return { bytes, mediaType: detectedMediaType };
}

export function sniffImageMediaType(
  bytes: Uint8Array,
): ChatMediaImageType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

export function normalizeSupportedMediaType(
  value: string | undefined,
): ChatMediaImageType | null {
  const normalized = value?.toLowerCase();
  return normalized &&
    (CHAT_MEDIA_IMAGE_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ChatMediaImageType)
    : null;
}

export function normalizeAttachmentName(value: string | undefined): string {
  const normalized = value?.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return normalized ? normalized.slice(0, 255) : "pasted-image";
}

export function encodeProviderImage(normalized: {
  bytes: Uint8Array;
  mediaType: ChatMediaImageType;
}): { type: "image"; image: string; mimeType: ChatMediaImageType } {
  let binary = "";
  for (let offset = 0; offset < normalized.bytes.length; offset += 8192) {
    binary += String.fromCharCode(
      ...normalized.bytes.subarray(offset, offset + 8192),
    );
  }
  return {
    type: "image",
    image: `data:${normalized.mediaType};base64,${btoa(binary)}`,
    mimeType: normalized.mediaType,
  };
}

function invalidImage(message: string): ChatImageValidationError {
  return new ChatImageValidationError(message);
}
