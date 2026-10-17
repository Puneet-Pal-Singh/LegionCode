import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";
import { imageSize } from "image-size";
import type { ChatMediaImageType } from "@repo/shared-types";
import { DomainError } from "../../domain/errors";
import type { ChatImageSettings } from "./ChatImageSettings";

interface NormalizedImage {
  bytes: Uint8Array;
  mediaType: ChatMediaImageType;
}

/** Full decoding and provider-size normalization; original R2 bytes stay intact. */
export function normalizeChatImage(
  bytes: Uint8Array,
  mediaType: ChatMediaImageType,
  settings: ChatImageSettings,
): NormalizedImage {
  // Read dimensions without allocating pixels. A small compressed file can
  // otherwise exhaust the Worker before the full decoder can reject it.
  const dimensions = readDimensions(bytes, mediaType);
  if (dimensions.width * dimensions.height > settings.maxDecodedPixels) {
    throw invalidImage(
      "Image dimensions exceed the safe decoding limit. Upload a smaller image.",
    );
  }
  let decoded: PhotonImage;
  try {
    decoded = PhotonImage.new_from_byteslice(bytes);
  } catch {
    throw invalidImage(
      "Image could not be decoded. Upload a valid PNG, JPEG, WebP, or GIF.",
    );
  }
  try {
    const width = decoded.get_width();
    const height = decoded.get_height();
    if (width !== dimensions.width || height !== dimensions.height) {
      throw invalidImage(
        "Decoded image dimensions do not match the image header.",
      );
    }
    if (
      width <= settings.maxWidth &&
      height <= settings.maxHeight &&
      encodedSize(bytes) <= settings.maxBase64Bytes
    ) {
      return { bytes, mediaType };
    }
    if (!settings.autoResize) {
      throw invalidImage(
        "Image exceeds configured dimensions or encoded size. Upload a smaller image or enable automatic resizing.",
      );
    }
    let scale = Math.min(
      1,
      settings.maxWidth / width,
      settings.maxHeight / height,
    );
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const targetWidth = Math.max(1, Math.floor(width * scale));
      const targetHeight = Math.max(1, Math.floor(height * scale));
      const resized = resize(
        decoded,
        targetWidth,
        targetHeight,
        SamplingFilter.Lanczos3,
      );
      try {
        const png = resized.get_bytes();
        if (encodedSize(png) <= settings.maxBase64Bytes)
          return { bytes: png, mediaType: "image/png" };
        for (const quality of [80, 70, 55, 40]) {
          const jpeg = resized.get_bytes_jpeg(quality);
          if (encodedSize(jpeg) <= settings.maxBase64Bytes)
            return { bytes: jpeg, mediaType: "image/jpeg" };
        }
      } finally {
        resized.free();
      }
      if (targetWidth === 1 && targetHeight === 1) break;
      scale *= 0.75;
    }
    throw invalidImage(
      "Image could not be resized below the configured provider limits.",
    );
  } finally {
    decoded.free();
  }
}

function readDimensions(bytes: Uint8Array, mediaType: ChatMediaImageType) {
  try {
    const dimensions = imageSize(bytes);
    const expectedType =
      mediaType === "image/jpeg" ? "jpg" : mediaType.slice(6);
    if (
      dimensions.type !== expectedType ||
      !dimensions.width ||
      !dimensions.height
    )
      throw new Error("Invalid dimensions");
    return dimensions;
  } catch {
    throw invalidImage(
      "Image content is invalid or does not match its declared MIME type.",
    );
  }
}

function encodedSize(bytes: Uint8Array): number {
  return 4 * Math.ceil(bytes.byteLength / 3);
}

function invalidImage(message: string): DomainError {
  return new DomainError("IMAGE_ATTACHMENT_INVALID", message, 400, false);
}
