import type { Message } from "@ai-sdk/react";
import type { ConversationScope } from "../conversationScope";

type MessageWithMetadataData = Message & {
  data: {
    metadata: Record<string, unknown>;
  };
};

export function attachActiveTurnIdentity(
  messages: Message[],
  scope: ConversationScope | null,
): Message[] {
  if (!scope) return messages;
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return messages;
  const assistant = messages[assistantIndex];
  if (!assistant || readMessageTurnId(assistant)) return messages;
  const metadata: Record<string, unknown> = {
    ...readMessageMetadata(assistant),
    canonicalIdentity: {
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      turnId: scope.turnId,
      runAttemptId: scope.runAttemptId,
    },
    phase: "final_answer",
  };
  const data = {
    ...readMessageData(assistant),
    metadata,
  };
  const next = [...messages];
  next[assistantIndex] = {
    ...assistant,
    data,
  } as MessageWithMetadataData;
  return next;
}

function readMessageData(message: Message): Record<string, unknown> {
  return message.data && typeof message.data === "object"
    ? (message.data as Record<string, unknown>)
    : {};
}

function readMessageMetadata(message: Message): Record<string, unknown> {
  const metadata = readMessageData(message).metadata;
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : {};
}

function readMessageTurnId(message: Message): string | null {
  const identity = readMessageMetadata(message).canonicalIdentity;
  if (!identity || typeof identity !== "object") return null;
  const turnId = (identity as Record<string, unknown>).turnId;
  return typeof turnId === "string" ? turnId : null;
}
