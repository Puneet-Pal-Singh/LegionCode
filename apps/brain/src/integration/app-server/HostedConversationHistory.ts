import { AppServerOperationError, type AppServerComposition } from "@legioncode/app-server/server";
import { InvalidTranscriptSnapshotError } from "@repo/persistence";
import type { JsonValue } from "@repo/shared-types";
import { ChatImageAttachmentRefSchema } from "@repo/shared-types";
import {
  ConversationHistoryResponseSchema,
  type ConversationHistoryRequest,
  type ConversationHistoryResponse,
} from "@repo/platform-protocol";
import type { TranscriptMessagePartRecord, TranscriptMessageRecord } from "@repo/persistence";
import type { Env } from "../../types/ai";
import { projectActiveTranscriptBranch } from "../../services/chat/TranscriptBranchProjection";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";

export class ConversationHistoryNotFoundError extends Error {}

/** The caller supplies the server-authenticated principal, never a client user ID. */
export async function readHostedConversationHistory(
  env: Env,
  userId: string,
  query: ConversationHistoryRequest,
): Promise<ConversationHistoryResponse> {
  const result = await withTranscriptRepository(env, (repository) =>
    repository.listTranscript({
      sessionId: query.session,
      userId,
      cursor: query.cursor === undefined ? undefined : Number(query.cursor),
      snapshot: query.snapshot === undefined ? undefined : Number(query.snapshot),
      limit: query.limit,
    }),
  );
  if (!result.sessionFound) throw new ConversationHistoryNotFoundError("Conversation not found");
  return ConversationHistoryResponseSchema.parse({
    messages: projectActiveTranscriptBranch(result.messages, result.supersededTurnIds).map(toHydrationMessage),
    nextCursor: result.nextCursor === null ? null : result.nextCursor.toString(),
    snapshot: result.snapshot.toString(),
  });
}

function toHydrationMessage(message: TranscriptMessageRecord): {
  id: string;
  role: TranscriptMessageRecord["role"];
  content: string | Array<{ type: "text"; text: string } | JsonValue>;
  createdAt: string;
  data?: {
    metadata?: Record<string, unknown>;
  };
} {
  const textContent = readSingleTextPart(message.parts);
  const data = readHydrationData(message.parts, message.sessionId);
  const hydratedMessage = {
    id: message.clientMessageId ?? message.id,
    role: message.role,
    content: textContent ?? message.parts.map(partToHydrationContent),
    createdAt: message.createdAt,
  };
  return data ? { ...hydratedMessage, data } : hydratedMessage;
}

function readSingleTextPart(
  parts: TranscriptMessagePartRecord[],
): string | null {
  if (parts.length !== 1 || parts[0]?.type !== "text") {
    return null;
  }

  const content = parts[0].content;
  if (typeof content === "object" && content && !Array.isArray(content)) {
    const text = content.text;
    return typeof text === "string" ? text : null;
  }

  return typeof content === "string" ? content : null;
}

function partToHydrationContent(
  part: TranscriptMessagePartRecord,
): { type: "text"; text: string } | JsonValue {
  if (part.type !== "text") {
    return part.content;
  }

  const text = readSingleTextPart([part]);
  return { type: "text", text: text ?? "" };
}

function readHydrationData(
  parts: TranscriptMessagePartRecord[],
  sessionId: string,
):
  | {
      metadata?: Record<string, unknown>;
    }
  | undefined {
  const metadata = parts
    .filter((part) => part.type === "text")
    .map((part) => readPartMetadata(part.content))
    .find((value): value is Record<string, unknown> => value !== null);
  if (!metadata) {
    return undefined;
  }
  const imageAttachments = readImageAttachmentRefs(metadata.imageAttachments)
    .map((attachment) => ({
      ...attachment,
      src: `/api/chat/media/${encodeURIComponent(attachment.attachmentId)}?session=${encodeURIComponent(sessionId)}`,
    }));
  return {
    metadata: {
      ...metadata,
      ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
    },
  };
}

function readImageAttachmentRefs(value: unknown): Array<{
  type: "image_attachment";
  attachmentId: string;
  name: string;
  mediaType: string;
  byteSize: number;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const parsed = ChatImageAttachmentRefSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function readPartMetadata(value: JsonValue): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const metadata = value.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : null;
}


export function composeHostedConversationHistory(
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["conversationHistoryService"]> {
  return {
    async readPage(params) {
      try {
        return await readHostedConversationHistory(env, userId, params);
      } catch (error) {
        if (error instanceof ConversationHistoryNotFoundError) {
          throw new AppServerOperationError(404, "not_found", "Conversation not found");
        }
        if (error instanceof InvalidTranscriptSnapshotError) {
          throw new AppServerOperationError(400, "invalid_request", error.message);
        }
        throw new AppServerOperationError(503, "server_unavailable", "Conversation history is unavailable");
      }
    },
  };
}
