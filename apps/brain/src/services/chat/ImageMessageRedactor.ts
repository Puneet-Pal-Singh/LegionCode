import type { CoreMessage } from "ai";

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export interface RedactedImageAttachmentMetadata {
  id: string;
  name?: string;
  mediaType: SupportedImageMimeType;
  byteSize: number;
  width?: number;
  height?: number;
  sha256?: string;
  source: "paste" | "upload";
  redacted: true;
}

interface ImagePartLike {
  type: "image";
  image: string;
  mimeType?: string;
  mediaType?: string;
  name?: string;
}

const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/;

export function messageHasImageParts(message: CoreMessage): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some(isImagePartLike);
}

export function buildRedactedMessageText(message: CoreMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  const textParts = message.content
    .map((part) => extractTextPart(part))
    .filter((text) => text.length > 0);
  const imageMarkers = extractImageParts(message.content).map((part, index) =>
    formatImageMarker(part, index),
  );
  const text = textParts.join("\n").trim();
  return [...(text ? [text] : []), ...imageMarkers].join("\n\n");
}

export function extractRedactedImageMetadata(
  message: CoreMessage,
): RedactedImageAttachmentMetadata[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return extractImageParts(message.content).map((part, index) => ({
    id: `image-${index + 1}`,
    name: part.name,
    mediaType: normalizeImageMimeType(part.mimeType ?? part.mediaType),
    byteSize: estimateDataUrlBytes(part.image),
    source: "paste",
    redacted: true,
  }));
}

export function isSupportedImageMimeType(
  value: string,
): value is SupportedImageMimeType {
  return SUPPORTED_IMAGE_MIME_TYPES.includes(value as SupportedImageMimeType);
}

export function parseImageDataUrl(value: string): {
  mediaType: string;
  byteSize: number;
} | null {
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const mediaType = match[1]?.toLowerCase();
  const base64 = match[2];
  if (!mediaType || !base64) {
    return null;
  }
  return {
    mediaType,
    byteSize: estimateBase64Bytes(base64),
  };
}

function extractImageParts(content: unknown[]): ImagePartLike[] {
  return content.filter(isImagePartLike);
}

function isImagePartLike(part: unknown): part is ImagePartLike {
  if (!part || typeof part !== "object") {
    return false;
  }
  const record = part as Record<string, unknown>;
  return record.type === "image" && typeof record.image === "string";
}

function extractTextPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return "";
  }
  const record = part as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  return "";
}

function formatImageMarker(part: ImagePartLike, index: number): string {
  const name = part.name?.trim() || `image-${index + 1}`;
  const mediaType = normalizeImageMimeType(part.mimeType ?? part.mediaType);
  const byteSize = formatBytes(estimateDataUrlBytes(part.image));
  return `[Image attached: ${name}, ${mediaType}, ${byteSize}]`;
}

function normalizeImageMimeType(value: string | undefined): SupportedImageMimeType {
  if (value && isSupportedImageMimeType(value)) {
    return value;
  }
  return "image/png";
}

function estimateDataUrlBytes(value: string): number {
  const parsed = parseImageDataUrl(value);
  return parsed?.byteSize ?? 0;
}

function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
