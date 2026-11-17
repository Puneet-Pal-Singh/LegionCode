import type { Message } from "@ai-sdk/react";
import type { ConversationHistoryDisplayRecord } from "@legioncode/sdk";

type ToolInvocation = NonNullable<Message["toolInvocations"]>[number];
type MessageWithMetadata = Message & { data?: { metadata?: Record<string, unknown> } };

/** Pure chat presentation over SDK-classified saved history; no reads or runtime state. */
export function convertConversationHistoryMessages(records: ConversationHistoryDisplayRecord[]): Message[] {
  return records.flatMap((record) => {
    const source = record.source;
    if (source.role !== "user" && source.role !== "assistant") return [];
    const content = record.parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text ?? "")
      .join("");
    const toolInvocations: ToolInvocation[] = record.parts.flatMap((part) => {
      if (
        source.role !== "assistant" ||
        part.kind !== "tool_call" ||
        part.toolName !== "create_code_artifact" ||
        !part.toolCallId ||
        part.args === undefined
      ) {
        return [];
      }
      return [{
        state: "result" as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.args,
        result: null,
      }];
    });
    const converted: Message = {
      id: source.id,
      role: source.role,
      content,
      createdAt: new Date(source.createdAt),
    };
    if (toolInvocations.length > 0) converted.toolInvocations = toolInvocations;
    return source.data?.metadata
      ? [attachMessageMetadata(converted, source.data.metadata)]
      : [converted];
  });
}

function attachMessageMetadata(
  message: Message,
  metadata: Record<string, unknown>,
): MessageWithMetadata {
  return { ...message, data: { metadata } } as MessageWithMetadata;
}
