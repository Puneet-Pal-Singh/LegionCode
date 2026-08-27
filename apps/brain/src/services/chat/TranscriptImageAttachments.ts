import type { CoreMessage } from "ai";
import type { TranscriptMessageRecord } from "@repo/persistence";
import {
  ChatImageAttachmentRefSchema,
  type ChatImageAttachmentRef,
} from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { DomainError } from "../../domain/errors";
import { ChatMediaStore } from "./ChatMediaStore";

export function readTranscriptImageAttachments(
  message: TranscriptMessageRecord,
): ChatImageAttachmentRef[] {
  return message.parts.flatMap((part) => {
    const content = readRecord(part.content);
    const metadata = readRecord(content?.metadata);
    if (metadata?.imageAttachments === undefined) return [];
    return ChatImageAttachmentRefSchema.array().parse(
      metadata.imageAttachments,
    );
  });
}

/** Resolve only opaque references from the authenticated transcript scope. */
export async function restoreTranscriptMessage(input: {
  env: Env;
  record: TranscriptMessageRecord;
  userId: string;
  sessionId: string;
}): Promise<CoreMessage[]> {
  const { record } = input;
  if (record.role === "tool") return [];
  const text = record.parts
    .map((part) =>
      typeof part.content === "string"
        ? part.content
        : readRecord(part.content)?.text,
    )
    .filter(
      (value): value is string => typeof value === "string" && !!value.trim(),
    )
    .join("\n");
  const refs = readTranscriptImageAttachments(record);
  const identity = { id: record.clientMessageId ?? record.id };
  if (refs.length === 0) {
    return text ? [{ ...identity, role: record.role, content: text }] : [];
  }
  if (record.role !== "user" || record.sessionId !== input.sessionId) {
    throw new DomainError(
      "CHAT_MEDIA_SCOPE_INVALID",
      "Image transcript scope is invalid.",
      403,
      false,
    );
  }
  if (!input.env.EDIT_ARTIFACTS) {
    throw new DomainError(
      "CHAT_MEDIA_UNAVAILABLE",
      "Chat image storage is unavailable.",
      503,
      true,
    );
  }
  const store = new ChatMediaStore(input.env.EDIT_ARTIFACTS);
  const images = [];
  // Bound peak decoding memory when a conversation contains several images.
  for (const ref of refs) {
    images.push(
      await store.getProviderImage({
        userId: input.userId,
        sessionId: input.sessionId,
        ref,
      }),
    );
  }
  return [
    {
      ...identity,
      role: "user",
      content: [...(text ? [{ type: "text" as const, text }] : []), ...images],
    },
  ];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
