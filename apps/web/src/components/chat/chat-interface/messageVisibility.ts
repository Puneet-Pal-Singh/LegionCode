import type { Message } from "@ai-sdk/react";
import { buildConversationTurns } from "../messageMetadata";

function isVisibleTerminalAssistantMessage(message: Message): boolean {
  if (message.role !== "assistant") {
    return false;
  }

  const metadata = readAssistantMessageMetadata(message);
  if (
    typeof metadata?.terminalState === "string" ||
    metadata?.finalMessageSource === "model" ||
    metadata?.finalMessageSource === "runtime"
  ) {
    return true;
  }

  return hasTerminalSummaryFrame(message.content);
}

function isVisibleAssistantMessage(message: Message): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (isVisibleTerminalAssistantMessage(message)) {
    return true;
  }
  return readMessageVisibleText(message).length > 0;
}

export function hasVisibleAssistantReply(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
): boolean {
  return conversationTurns.some(
    (turn) =>
      Boolean(turn.userMessage) &&
      Boolean(
        turn.assistantMessage &&
        isVisibleAssistantMessage(turn.assistantMessage),
      ),
  );
}

function readAssistantMessageMetadata(
  message: Message,
): Record<string, unknown> | null {
  const data = (message as Message & { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const metadata = (data as Record<string, unknown>).metadata;
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : null;
}

function hasTerminalSummaryFrame(content: Message["content"]): boolean {
  const text = readVisibleText(content);
  return (
    text.includes("Outcome:") &&
    (text.includes("Next action:") || text.includes("Next step:"))
  );
}

function readMessageVisibleText(message: Message): string {
  return readVisibleText(message.content);
}

function readVisibleText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("")
    .trim();
}
