import type { CoreMessage } from "ai";
import { ValidationError } from "../../domain/errors";

export function applySubmittedClientMessageId(
  messages: CoreMessage[],
  clientMessageId: string | undefined,
  correlationId: string,
): CoreMessage[] {
  if (!clientMessageId) {
    return messages;
  }

  const latestUserIndex = findLatestUserMessageIndex(messages);
  if (latestUserIndex === -1) {
    return messages;
  }

  const latestUserMessage = messages[latestUserIndex];
  if (!latestUserMessage) {
    return messages;
  }
  const existingId = readMessageId(latestUserMessage);
  if (existingId && existingId !== clientMessageId) {
    throw new ValidationError(
      "Submitted client message id does not match the latest user message id",
      "CLIENT_MESSAGE_ID_MISMATCH",
      correlationId,
    );
  }
  if (existingId === clientMessageId) {
    return messages;
  }

  return messages.map((message, index) =>
    index === latestUserIndex
      ? attachClientMessageId(message, clientMessageId)
      : message,
  );
}

export function summarizeCoreMessages(messages: CoreMessage[]): string {
  return messages
    .map((message) => `${message.role}:${readMessageId(message) ?? "missing"}`)
    .join(",");
}

function findLatestUserMessageIndex(messages: CoreMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function readMessageId(message: CoreMessage): string | null {
  const candidate = message as { id?: unknown };
  return typeof candidate.id === "string" ? candidate.id : null;
}

function attachClientMessageId(
  message: CoreMessage,
  clientMessageId: string,
): CoreMessage {
  return {
    ...(message as object),
    id: clientMessageId,
  } as unknown as CoreMessage;
}
