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

/** The canonical Turn owner reauthorizes the current grant/thread before and
 * after each bounded private-byte read. Renderer IDs never select a host path. */
export class LocalChatMediaReads {
  constructor(private readonly options: {
    turns: { getTurn(turnId: TurnId): Promise<TurnAdmission> };
    store: Pick<LocalChatMediaStore, "readOriginal">;
  }) {}

  async readImage(input: LocalChatImageReadParams) {
    const request = LocalChatImageReadParamsSchema.parse(input);
    const admission = TurnAdmissionSchema.parse(await this.options.turns.getTurn(request.turnId));
    if (admission.turn.id !== request.turnId) throw unavailable();
    const references = z.array(ChatImageAttachmentRefSchema).max(LOCAL_CHAT_MEDIA_LIMITS.maxImages)
      .safeParse(admission.userMessage.content.images);
    const reference = references.success
      ? references.data.find((ref) => ref.attachmentId === request.attachmentId) : undefined;
    if (!reference) throw new AppServerOperationError(404, "not_found", "Conversation image was not found");
    try {
      const saved = await this.options.store.readOriginal({
        scope: {
          userId: admission.run.userId, workspaceId: admission.run.workspaceId,
          threadId: admission.run.threadId, runId: admission.run.id,
          turnId: admission.turn.id, runAttemptId: admission.runAttemptId,
        },
        reference,
      });
      const current = TurnAdmissionSchema.parse(await this.options.turns.getTurn(request.turnId));
      if (!isDeepStrictEqual(current, admission) || saved.fingerprint !== admission.userMessage.content.imageFingerprint) throw unavailable();
      if (request.offset >= saved.bytes.byteLength) {
        throw new AppServerOperationError(400, "invalid_request", "Image byte range is invalid");
      }
      const end = Math.min(saved.bytes.byteLength, request.offset + (request.limit ?? LOCAL_CHAT_IMAGE_CHUNK_MAX_BYTES));
      return LocalChatImageReadResultSchema.parse({
        reference, sha256: saved.sha256, offset: request.offset,
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
}
function unavailable(): AppServerOperationError {
  return new AppServerOperationError(503, "server_unavailable", "Conversation image could not be verified", "chat_image_unavailable", false);
}
