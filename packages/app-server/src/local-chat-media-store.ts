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
  type LocalChatMediaStoredScope,
} from "./local-chat-media-records.js";
import type { LocalTurnMediaPort, LocalTurnMediaScope, LocalProviderImagePart, LocalTurnPreparedMedia, LocalTurnMediaDisposal } from "./local-turn-media.js";
import { LocalChatMediaResources, type LocalChatMediaAdmissionLookup } from "./local-chat-media-resources.js";
import {
  LocalQueuedInputMediaScopeSchema, LocalQueuedInputMediaOwnershipSchema,
  type LocalQueuedInputMediaLookup, type LocalQueuedInputMediaOwnership,
  type LocalQueuedInputMediaPort, type LocalQueuedInputMediaRead,
} from "./local-queued-input-media.js";

/** Original private bytes only. Shared chat-media owns every image parser and
 * normalizer; canonical admission owns all references and scope authorization.
 */
export class LocalChatMediaStore implements LocalTurnMediaPort, LocalQueuedInputMediaPort {
  readonly limits = LOCAL_CHAT_MEDIA_LIMITS;
  private readonly files: LocalChatMediaFiles;
  private readonly settings: ChatImageSettings;
  private readonly resources: LocalChatMediaResources;
  private activeIO = 0;
  private readonly queuedMediaAvailable: boolean;
  constructor(options: { storageDirectory: string; settings?: ChatImageSettings;
    lookupAdmission?: LocalChatMediaAdmissionLookup; lookupThreadInput?: LocalQueuedInputMediaLookup }) {
    this.files = new LocalChatMediaFiles(options.storageDirectory);
    this.resources = new LocalChatMediaResources(this.files, options.storageDirectory, options.lookupAdmission, options.lookupThreadInput);
    this.queuedMediaAvailable = options.lookupThreadInput !== undefined;
    this.settings = Object.freeze(ChatImageSettingsSchema.parse(options.settings ?? DEFAULT_CHAT_IMAGE_SETTINGS));
  }

  async prepare(input: Parameters<LocalTurnMediaPort["prepare"]>[0], signal?: AbortSignal): Promise<LocalTurnPreparedMedia & LocalTurnMediaDisposal> {
    const images = this.decodeImages(input, signal);
    await this.withIO(() => this.resources.ready());
    signal?.throwIfAborted();
    return this.preparation(images, (scope: unknown) => LocalChatMediaScopeSchema.parse(scope), signal);
  }

  async prepareQueued(input: Parameters<LocalQueuedInputMediaPort["prepareQueued"]>[0], signal?: AbortSignal) {
    this.requireQueuedMedia();
    const images = this.decodeImages(input, signal);
    await this.withIO(() => this.resources.ready());
    signal?.throwIfAborted();
    return this.preparation(images, (scope: unknown) => LocalQueuedInputMediaScopeSchema.parse(scope), signal);
  }

  async promoteQueued(input: LocalQueuedInputMediaRead): Promise<LocalTurnPreparedMedia> {
    return this.withIO(async () => {
      const { images, ownership } = await this.readQueuedImages(input);
      for (const image of images) normalizeChatImage(image.bytes, image.mediaType, this.settings);
      input.signal?.throwIfAborted();
      return this.preparation(images, (scope: unknown) => LocalChatMediaScopeSchema.parse(scope), input.signal,
        () => this.resources.assertQueuedAccepted(ownership));
    });
  }

  async resolveQueuedForProvider(input: LocalQueuedInputMediaRead): Promise<readonly LocalProviderImagePart[]> {
    return this.withIO(async () => {
      const { images } = await this.readQueuedImages(input);
      const parts = images.map((image) => {
        input.signal?.throwIfAborted();
        return encodeProviderImage(normalizeChatImage(image.bytes, image.mediaType, this.settings));
      });
      input.signal?.throwIfAborted();
      return parts;
    });
  }

  private decodeImages(input: Parameters<LocalTurnMediaPort["prepare"]>[0], signal?: AbortSignal): LocalDecodedChatImage[] {
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
    return images;
  }

  private preparation<TScope extends LocalChatMediaStoredScope>(
    images: LocalDecodedChatImage[], parseScope: (scope: unknown) => TScope,
    signal?: AbortSignal, verifySource?: () => Promise<void>,
  ) {
    const fingerprint = mediaFingerprint(images);
    let scopeKey: string | undefined;
    let record: LocalChatMediaRecord | undefined;
    let publication: Promise<readonly ChatImageAttachmentRef[]> | undefined;
    let discarding = false;
    const assertPending = () => {
      signal?.throwIfAborted();
      if (discarding) throw new LocalChatMediaError("unavailable", "Image preparation is closing");
    };
    return {
      fingerprint,
      persist: async (inputScope: TScope): Promise<readonly ChatImageAttachmentRef[]> => {
        assertPending();
        const scope = parseScope(inputScope);
        const key = mediaScopeKey(scope);
        if (scopeKey !== undefined && scopeKey !== key) throw new LocalChatMediaError("conflict", "Prepared images belong to a different Turn scope");
        scopeKey = key;
        if (images.length) record ??= createMediaRecord(scope, images);
        publication ??= this.withIO(async () => {
          assertPending();
          await verifySource?.();
          assertPending();
          if (!record) return Object.freeze([]);
          await this.resources.publish(record, images, signal);
          await verifySource?.();
          assertPending();
          return Object.freeze(record.images.map(({ reference }) => Object.freeze({ ...reference })));
        });
        return publication;
      },
      discardUnadmitted: async (confirmScopeAbsence: (scope: TScope) => Promise<boolean>) => {
        discarding = true;
        // The token retains its bound record even when publication rejects.
        // Do not race cleanup against an owned write or a caller's admit call.
        await publication?.catch(() => undefined);
        const bound = record;
        if (!bound) return true;
        try { return await this.withIO(() => this.resources.discardUnadmitted(bound,
          (scope) => confirmScopeAbsence(parseScope(scope)))); }
        catch { return false; }
      },
    };
  }

  private async readQueuedImages(input: LocalQueuedInputMediaRead): Promise<{
    images: LocalDecodedChatImage[]; ownership: LocalQueuedInputMediaOwnership;
  }> {
    this.requireQueuedMedia();
    input.signal?.throwIfAborted();
    const ownership = LocalQueuedInputMediaOwnershipSchema.parse({
      scope: input.scope, fingerprint: input.fingerprint, references: input.references,
    });
    if (new Set(ownership.references.map((reference) => reference.attachmentId)).size !== ownership.references.length ||
        ownership.references.reduce((bytes, reference) => bytes + reference.byteSize, 0) > this.limits.maxTotalBytes) {
      throw new LocalChatMediaError("invalid_image", "Image references exceed their supported limits");
    }
    await this.resources.assertQueuedAccepted(ownership);
    const images: LocalDecodedChatImage[] = [];
    for (const reference of ownership.references) {
      input.signal?.throwIfAborted();
      const saved = await this.files.read(ownership.scope, reference.attachmentId);
      if (saved.record.version !== 2 || saved.record.fingerprint !== ownership.fingerprint ||
          !isDeepStrictEqual(saved.record.images.map((image) => image.reference), ownership.references) ||
          !isDeepStrictEqual(saved.image.reference, reference) || sniffImageMediaType(saved.bytes) !== reference.mediaType) {
        throw new LocalChatMediaError("unavailable", "Stored queued image metadata could not be verified");
      }
      images.push({ bytes: saved.bytes, mediaType: reference.mediaType, name: reference.name, sha256: saved.image.sha256 });
    }
    await this.resources.assertQueuedAccepted(ownership);
    input.signal?.throwIfAborted();
    return { images, ownership };
  }

  private requireQueuedMedia(): void {
    if (!this.queuedMediaAvailable) throw new LocalChatMediaError("unavailable", "Queued image ownership is unavailable");
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
