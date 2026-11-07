import { isDeepStrictEqual } from "node:util";
import {
  ChatImageAttachmentRefSchema, ThreadInputImageSchema,
  type ChatImageAttachmentRef,
} from "@repo/platform-protocol";
import {
  decodeAndValidateImage, normalizeAttachmentName, sniffImageMediaType,
  encodeProviderImage, ChatImageValidationError,
} from "@repo/chat-media/validation";
import { normalizeChatImage } from "@repo/chat-media/normalizer";
import { ChatImageSettingsSchema, DEFAULT_CHAT_IMAGE_SETTINGS, type ChatImageSettings } from "@repo/chat-media/settings";
import { z } from "zod";
import { LocalChatMediaFiles } from "./local-chat-media-files.js";
import {
  LOCAL_CHAT_MEDIA_LIMITS, LocalChatMediaError, LocalChatMediaScopeSchema,
  createMediaRecord, mediaDigest, mediaFingerprint, mediaScopeKey,
  type LocalDecodedChatImage,
  type LocalChatMediaRecord,
} from "./local-chat-media-records.js";
import type { LocalTurnMediaPort, LocalTurnMediaScope, LocalProviderImagePart, LocalTurnPreparedMedia, LocalTurnMediaDisposal } from "./local-turn-media.js";
import { LocalChatMediaResources, type LocalChatMediaAdmissionLookup } from "./local-chat-media-resources.js";

/** Original private bytes only. Shared chat-media owns every image parser and
 * normalizer; canonical admission owns all references and scope authorization.
 */
export class LocalChatMediaStore implements LocalTurnMediaPort {
  readonly limits = LOCAL_CHAT_MEDIA_LIMITS;
  private readonly files: LocalChatMediaFiles;
  private readonly settings: ChatImageSettings;
  private readonly resources: LocalChatMediaResources;
  private activeIO = 0;
  constructor(options: { storageDirectory: string; settings?: ChatImageSettings; lookupAdmission?: LocalChatMediaAdmissionLookup }) {
    this.files = new LocalChatMediaFiles(options.storageDirectory);
    this.resources = new LocalChatMediaResources(this.files, options.storageDirectory, options.lookupAdmission);
    this.settings = Object.freeze(ChatImageSettingsSchema.parse(options.settings ?? DEFAULT_CHAT_IMAGE_SETTINGS));
  }

  async prepare(input: Parameters<LocalTurnMediaPort["prepare"]>[0], signal?: AbortSignal): Promise<LocalTurnPreparedMedia & LocalTurnMediaDisposal> {
    signal?.throwIfAborted();
    let images: LocalDecodedChatImage[];
    try {
      const inputs = z.array(ThreadInputImageSchema).max(this.limits.maxImages).parse(input);
      let totalBytes = 0;
      images = inputs.map((image) => {
        signal?.throwIfAborted();
        const decoded = decodeAndValidateImage({ image: image.dataUrl, mediaType: image.mediaType, name: image.name });
        totalBytes += decoded.bytes.byteLength;
        if (totalBytes > this.limits.maxTotalBytes) throw new ChatImageValidationError("Attached images must be 10 MiB or smaller in total");
        // Full decoding and provider-limit validation happen before any disk
        // publication. Original bytes are retained, never the resized derivative.
        normalizeChatImage(decoded.bytes, decoded.mediaType, this.settings);
        return { ...decoded, name: normalizeAttachmentName(image.name), sha256: mediaDigest(decoded.bytes) };
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new LocalChatMediaError("invalid_image", error instanceof ChatImageValidationError
        ? error.message : "Image attachments are invalid or exceed their supported limits");
    }
    await this.withIO(() => this.resources.ready());
    signal?.throwIfAborted();
    const fingerprint = mediaFingerprint(images);
    let scopeKey: string | undefined;
    let record: LocalChatMediaRecord | undefined;
    let publication: Promise<readonly ChatImageAttachmentRef[]> | undefined;
    return {
      fingerprint,
      persist: async (inputScope: LocalTurnMediaScope): Promise<readonly ChatImageAttachmentRef[]> => {
        const scope = LocalChatMediaScopeSchema.parse(inputScope);
        const key = mediaScopeKey(scope);
        if (scopeKey !== undefined && scopeKey !== key) throw new LocalChatMediaError("conflict", "Prepared images belong to a different Turn scope");
        scopeKey = key;
        if (images.length) record ??= createMediaRecord(scope, images);
        publication ??= this.withIO(async () => {
          signal?.throwIfAborted();
          if (!record) return Object.freeze([]);
          await this.resources.publish(record, images, signal);
          signal?.throwIfAborted();
          return Object.freeze(record.images.map(({ reference }) => Object.freeze({ ...reference })));
        });
        return publication;
      },
      discardUnadmitted: async (confirmScopeAbsence: (scope: LocalTurnMediaScope) => Promise<boolean>) => {
        // The token retains its bound record even when publication rejects.
        // Do not race cleanup against an owned write or a caller's admit call.
        await publication?.catch(() => undefined);
        const bound = record;
        if (!bound) return true;
        try { return await this.withIO(() => this.resources.discardUnadmitted(bound, confirmScopeAbsence)); }
        catch { return false; }
      },
    };
  }

  async readOriginal(input: {
    scope: LocalTurnMediaScope; reference: ChatImageAttachmentRef; signal?: AbortSignal;
  }): Promise<{ reference: ChatImageAttachmentRef; bytes: Uint8Array; sha256: string; fingerprint: string }> {
    return this.withIO(() => this.readVerified(input));
  }

  async resolveForProvider(input: Parameters<LocalTurnMediaPort["resolveForProvider"]>[0]) {
    return this.withIO(async () => {
      const references = z.array(ChatImageAttachmentRefSchema).max(this.limits.maxImages).parse(input.references);
      if (new Set(references.map((ref) => ref.attachmentId)).size !== references.length ||
        references.reduce((sum, ref) => sum + ref.byteSize, 0) > this.limits.maxTotalBytes) {
        throw new LocalChatMediaError("invalid_image", "Image references exceed their supported limits");
      }
      const parts: LocalProviderImagePart[] = [];
      for (const reference of references) {
        input.signal?.throwIfAborted();
        const image = await this.readVerified({ ...input, reference });
        if (image.fingerprint !== input.fingerprint) {
          throw new LocalChatMediaError("unavailable", "Stored image fingerprint does not match the admitted content");
        }
        const normalized = normalizeChatImage(image.bytes, image.reference.mediaType, this.settings);
        parts.push(encodeProviderImage(normalized));
      }
      input.signal?.throwIfAborted();
      return parts;
    });
  }

  private async readVerified(input: {
    scope: LocalTurnMediaScope; reference: ChatImageAttachmentRef; signal?: AbortSignal;
  }) {
    input.signal?.throwIfAborted();
    await this.resources.ready();
    input.signal?.throwIfAborted();
    const reference = ChatImageAttachmentRefSchema.parse(input.reference);
    const saved = await this.files.read(LocalChatMediaScopeSchema.parse(input.scope), reference.attachmentId);
    input.signal?.throwIfAborted();
    if (!isDeepStrictEqual(saved.image.reference, reference) || sniffImageMediaType(saved.bytes) !== reference.mediaType) {
      throw new LocalChatMediaError("unavailable", "Stored image metadata could not be verified");
    }
    return { reference, bytes: saved.bytes, sha256: saved.image.sha256, fingerprint: saved.record.fingerprint };
  }
  private async withIO<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeIO >= 4) throw new LocalChatMediaError("unavailable", "Local image storage is busy");
    this.activeIO += 1;
    try { return await operation(); }
    catch (error) {
      if (error instanceof LocalChatMediaError || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new LocalChatMediaError("unavailable", "Local image storage is unavailable");
    } finally { this.activeIO -= 1; }
  }
}
