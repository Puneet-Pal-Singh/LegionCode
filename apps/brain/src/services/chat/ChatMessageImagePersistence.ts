import type { CoreMessage } from "ai";
import type { ChatImageAttachmentRef } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { DomainError } from "../../domain/errors";
import { withTranscriptRepository } from "../sessions/TranscriptPersistenceFactory";
import { ChatMediaStore } from "./ChatMediaStore";
import {
  extractImageParts,
  messageHasImageParts,
} from "./ImageMessageRedactor";
import { readCanonicalIdentityField } from "./TranscriptBranchProjection";
import { readTranscriptImageAttachments } from "./TranscriptImageAttachments";

export async function persistChatMessageImages(
  env: Env,
  input: {
    sessionId: string;
    userId?: string;
    message: CoreMessage;
    idempotencyKey: string;
    revisionOfTurnId?: string;
  },
): Promise<ChatImageAttachmentRef[]> {
  if (messageHasImageParts(input.message)) {
    const userId = input.userId;
    if (!userId || !env.EDIT_ARTIFACTS) {
      throw new Error(
        "Chat image persistence requires an authenticated R2 binding.",
      );
    }
    const store = new ChatMediaStore(env.EDIT_ARTIFACTS);
    const images = extractImageParts(input.message.content as unknown[]);
    return Promise.all(
      images.map((image, index) =>
        store.putImage({
          userId,
          sessionId: input.sessionId,
          attachmentId: `img_${input.idempotencyKey.slice(0, 48)}_${index}`,
          image,
        }),
      ),
    );
  }
  if (!input.revisionOfTurnId) return [];
  const userId = input.userId;
  if (!userId) throw revisionUnavailable();
  // Text editing changes text only. The original authenticated transcript owns
  // its attachments even when the client has reloaded and no longer has bytes.
  return withTranscriptRepository(env, async (repository) => {
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await repository.listTranscript({
        userId,
        sessionId: input.sessionId,
        cursor,
        limit: 100,
      });
      const original = page.messages.find(
        (message) =>
          message.role === "user" &&
          readCanonicalIdentityField(message, "turnId") ===
            input.revisionOfTurnId,
      );
      if (original) return readTranscriptImageAttachments(original);
      cursor = page.nextCursor;
    }
    throw revisionUnavailable();
  });
}

function revisionUnavailable(): DomainError {
  return new DomainError(
    "REVISION_MESSAGE_UNAVAILABLE",
    "The original message is unavailable in this session.",
    404,
    false,
  );
}
