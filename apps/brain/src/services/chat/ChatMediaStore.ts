import type { R2Bucket } from "@cloudflare/workers-types";
import {
  ChatImageAttachmentRefSchema,
  type ChatImageAttachmentRef,
  type ChatMediaImageType,
} from "@repo/shared-types";
import { DomainError } from "../../domain/errors";
import {
  encodeProviderImage,
  isValidChatMediaAttachmentId,
  normalizeAttachmentName,
  normalizeSupportedMediaType,
  sniffImageMediaType,
  type IncomingChatImage,
} from "@repo/chat-media/validation";
import {
  decodeAndValidateImage,
  normalizeChatImage,
} from "./ChatImageNormalizer";
import {
  DEFAULT_CHAT_IMAGE_SETTINGS,
  type ChatImageSettings,
} from "./ChatImageSettings";

export {
  CHAT_MEDIA_MAX_IMAGE_BYTES,
  isValidChatMediaAttachmentId,
  type IncomingChatImage,
} from "@repo/chat-media/validation";

export interface ChatMediaObject {
  body: unknown;
  mediaType: ChatMediaImageType;
  byteSize: number;
}

/**
 * Stores user-provided images under the existing EDIT_ARTIFACTS R2 binding.
 * The key is deliberately made only from authenticated scope and an opaque
 * server id; filenames never become object paths.
 */
export class ChatMediaStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly settings: ChatImageSettings = DEFAULT_CHAT_IMAGE_SETTINGS,
  ) {}

  static key(userId: string, sessionId: string, attachmentId: string): string {
    return `chat-media/${encodeKeySegment(userId)}/${encodeKeySegment(sessionId)}/${encodeKeySegment(attachmentId)}`;
  }

  async putImage(input: {
    userId: string;
    sessionId: string;
    attachmentId: string;
    image: IncomingChatImage;
  }): Promise<ChatImageAttachmentRef> {
    const decoded = decodeAndValidateImage(input.image);
    normalizeChatImage(decoded.bytes, decoded.mediaType, this.settings);
    if (!isValidChatMediaAttachmentId(input.attachmentId)) {
      throw invalidImage("Image attachment identity is invalid.");
    }
    const attachmentId = input.attachmentId;
    const key = ChatMediaStore.key(input.userId, input.sessionId, attachmentId);
    await this.bucket.put(key, decoded.bytes, {
      httpMetadata: {
        contentType: decoded.mediaType,
        contentDisposition: "inline",
        cacheControl: "private, max-age=300",
      },
      customMetadata: {
        userId: input.userId,
        sessionId: input.sessionId,
        attachmentId,
      },
    });

    return ChatImageAttachmentRefSchema.parse({
      type: "image_attachment",
      attachmentId,
      name: normalizeAttachmentName(input.image.name),
      mediaType: decoded.mediaType,
      byteSize: decoded.bytes.byteLength,
    });
  }

  async getImage(input: {
    userId: string;
    sessionId: string;
    attachmentId: string;
  }): Promise<ChatMediaObject | null> {
    const object = await this.bucket.get(
      ChatMediaStore.key(input.userId, input.sessionId, input.attachmentId),
    );
    if (!object) return null;

    const mediaType = normalizeSupportedMediaType(
      object.httpMetadata?.contentType,
    );
    if (!mediaType) {
      throw new DomainError(
        "CHAT_MEDIA_METADATA_INVALID",
        "Stored image metadata is invalid.",
        500,
        false,
      );
    }
    return {
      body: object.body,
      mediaType,
      byteSize: object.size,
    };
  }

  async getProviderImage(input: {
    userId: string;
    sessionId: string;
    ref: ChatImageAttachmentRef;
  }): Promise<{ type: "image"; image: string; mimeType: ChatMediaImageType }> {
    const ref = ChatImageAttachmentRefSchema.parse(input.ref);
    const object = await this.bucket.get(
      ChatMediaStore.key(input.userId, input.sessionId, ref.attachmentId),
    );
    if (!object) {
      throw new DomainError(
        "CHAT_MEDIA_NOT_FOUND",
        "A conversation image is unavailable.",
        404,
        false,
      );
    }
    if (
      object.size !== ref.byteSize ||
      object.httpMetadata?.contentType !== ref.mediaType
    ) {
      throw new DomainError(
        "CHAT_MEDIA_METADATA_INVALID",
        "Stored image metadata does not match its reference.",
        500,
        false,
      );
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (
      bytes.byteLength !== ref.byteSize ||
      sniffImageMediaType(bytes) !== ref.mediaType
    ) {
      throw new DomainError(
        "CHAT_MEDIA_CONTENT_INVALID",
        "Stored image content is invalid.",
        500,
        false,
      );
    }
    const normalized = normalizeChatImage(bytes, ref.mediaType, this.settings);
    return encodeProviderImage(normalized);
  }
}

function encodeKeySegment(value: string): string {
  return encodeURIComponent(value);
}

function invalidImage(message: string): DomainError {
  return new DomainError("IMAGE_ATTACHMENT_INVALID", message, 400, false);
}
