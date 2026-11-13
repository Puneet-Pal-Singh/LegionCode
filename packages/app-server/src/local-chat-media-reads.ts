import type { LocalPersistence } from "@repo/event-store/local";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  ChatImageAttachmentRefSchema, TurnAdmissionSchema,
  type TurnAdmission, type TurnId,
} from "@repo/platform-protocol";
import {
  LOCAL_CHAT_IMAGE_CHUNK_MAX_BYTES, LocalChatImageReadParamsSchema,
  LocalChatImageReadResultSchema, type LocalChatImageReadParams,
} from "./protocol.js";
import { LocalChatMediaError, LOCAL_CHAT_MEDIA_LIMITS } from "./local-chat-media-records.js";
import type { LocalChatMediaStore } from "./local-chat-media-store.js";
import { AppServerOperationError } from "./server.js";
import { localQueuedInputMediaRead } from "./local-queued-input-media.js";

/** The canonical Turn owner reauthorizes the current grant/thread before and
 * after each bounded private-byte read. Renderer IDs never select a host path. */
export class LocalChatMediaReads {
  constructor(private readonly options: {
    turns: { getTurn(turnId: TurnId): Promise<TurnAdmission> };
    store: Pick<LocalChatMediaStore, "readOriginal"> & Partial<Pick<LocalChatMediaStore, "readQueuedOriginal">>;
    queuedInputs?: Pick<LocalPersistence["threadInputs"], "listAcceptedForTurn">;
  }) {}

  async readImage(input: LocalChatImageReadParams) {
    const request = LocalChatImageReadParamsSchema.parse(input);
    const admission = TurnAdmissionSchema.parse(await this.options.turns.getTurn(request.turnId));
    const prompt = admission.userMessage;
    if (admission.turn.id !== request.turnId || prompt.type !== "user_message") throw unavailable();
    const references = z.array(ChatImageAttachmentRefSchema).max(LOCAL_CHAT_MEDIA_LIMITS.maxImages)
      .safeParse(prompt.content.images);
    const reference = references.success
      ? references.data.find((ref) => ref.attachmentId === request.attachmentId) : undefined;
    try {
      const saved = reference ? await this.options.store.readOriginal({
        scope: {
          userId: admission.run.userId, workspaceId: admission.run.workspaceId,
          threadId: admission.run.threadId, runId: admission.run.id,
          turnId: admission.turn.id, runAttemptId: admission.runAttemptId,
        }, reference,
      }) : await this.readAcceptedInputOriginal(admission, request.attachmentId);
      const current = TurnAdmissionSchema.parse(await this.options.turns.getTurn(request.turnId));
      if (!isDeepStrictEqual(current, admission) ||
          (reference && saved.fingerprint !== prompt.content.imageFingerprint)) throw unavailable();
      if (request.offset >= saved.bytes.byteLength) {
        throw new AppServerOperationError(400, "invalid_request", "Image byte range is invalid");
      }
      const end = Math.min(saved.bytes.byteLength, request.offset + (request.limit ?? LOCAL_CHAT_IMAGE_CHUNK_MAX_BYTES));
      return LocalChatImageReadResultSchema.parse({
        reference: saved.reference, sha256: saved.sha256, offset: request.offset,
        byteLength: end - request.offset,
        dataBase64: Buffer.from(saved.bytes.subarray(request.offset, end)).toString("base64"),
        nextOffset: end < saved.bytes.byteLength ? end : null,
      });
    } catch (error) {
      if (error instanceof AppServerOperationError) throw error;
      if (error instanceof LocalChatMediaError) throw unavailable();
      throw unavailable();
    }
  }

  private async readAcceptedInputOriginal(admission: TurnAdmission, attachmentId: string) {
    if (!this.options.queuedInputs)
      throw new AppServerOperationError(404, "not_found", "Conversation image was not found");
    const scope = { sessionId: admission.run.threadId, threadId: admission.run.threadId,
      userId: admission.run.userId, workspaceId: admission.run.workspaceId,
      turnId: admission.turn.id, runAttemptId: admission.runAttemptId };
    const inputs = await this.options.queuedInputs.listAcceptedForTurn(scope);
    const matches = inputs.flatMap((item) => item.mediaRefs.filter((reference) => reference.attachmentId === attachmentId)
      .map((reference) => ({ item, reference })));
    if (!matches.length) throw new AppServerOperationError(404, "not_found", "Conversation image was not found");
    if (matches.length !== 1 || !this.options.store.readQueuedOriginal) throw unavailable();
    const { item, reference } = matches[0]!;
    if (!item.mediaRevision || !item.mediaFingerprint) throw unavailable();
    const saved = await this.options.store.readQueuedOriginal({ ...localQueuedInputMediaRead(item), reference });
    const current = (await this.options.queuedInputs.listAcceptedForTurn(scope)).find((candidate) => candidate.itemId === item.itemId);
    if (!current || current.mediaRevision !== item.mediaRevision || current.mediaFingerprint !== item.mediaFingerprint ||
        !isDeepStrictEqual(current.mediaRefs, item.mediaRefs)) throw unavailable();
    return saved;
  }

}
function unavailable(): AppServerOperationError {
  return new AppServerOperationError(503, "server_unavailable", "Conversation image could not be verified", "chat_image_unavailable", false);
}
