import type { CoreMessage } from "ai";
import { CONTEXT_COMPACTION_SUMMARY_MAX_CHARS } from "@repo/platform-protocol";

// A preflight allowance, not provider-measured usage. Encoding length is not
// visual token cost; measured provider usage replaces this estimate later.
const IMAGE_TOKEN_ALLOWANCE = 4_096;

export function buildProviderContextMessages(input: {
  messages: readonly CoreMessage[];
  compactedContext: string | null;
}): CoreMessage[] {
  if (!input.compactedContext) return [...input.messages];
  let latestUserIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const history =
    latestUserIndex < 0 ? [] : input.messages.slice(0, latestUserIndex);
  return [
    ...history.filter((message) => message.role === "system"),
    {
      role: "system",
      content: `Compacted conversation context:\n${input.compactedContext}`,
    },
    // Text summaries cannot replace pixels. Preserve historical image inputs
    // and the entire active turn, including paired tool calls and results.
    ...history.filter(hasUserImages),
    ...input.messages.slice(Math.max(0, latestUserIndex)),
  ];
}

export function estimateConversationTokens(
  messages: readonly CoreMessage[],
): number {
  return Math.max(
    1,
    Math.ceil(
      messages.reduce(
        (total, message) => total + 16 + readMessageText(message).length,
        0,
      ) / 4,
    ),
  );
}

export function estimateAttachmentTokens(
  messages: readonly CoreMessage[],
): number {
  return messages.reduce(
    (total, message) =>
      total +
      (Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "image").length *
          IMAGE_TOKEN_ALLOWANCE
        : 0),
    0,
  );
}

export function summarizeConversationForCompaction(
  messages: readonly CoreMessage[],
  prompt: string,
): string {
  const header = `Active user request: ${boundText(prompt, 1_000)}\nPreserved conversation excerpts:\n`;
  const transcript = messages
    .map((message) => `${message.role}: ${readMessageText(message)}`)
    .join("\n");
  return (
    header +
    boundText(transcript, CONTEXT_COMPACTION_SUMMARY_MAX_CHARS - header.length)
  );
}

function hasUserImages(message: CoreMessage): boolean {
  return (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image")
  );
}

function readMessageText(message: CoreMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
          return `[Image attached${part.mimeType ? `: ${part.mimeType}` : ""}]`;
        case "file":
          return `[File attached: ${part.mimeType}]`;
        case "tool-call":
          return `Tool call ${part.toolCallId} ${part.toolName}: ${JSON.stringify(part.args)}`;
        case "tool-result":
          return `Tool result ${part.toolCallId} ${part.toolName}: ${JSON.stringify(part.result)}`;
        default:
          return "";
      }
    })
    .join("\n");
}

function boundText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n[...omitted...]\n";
  const head = Math.ceil((limit - marker.length) / 2);
  return (
    text.slice(0, head) + marker + text.slice(-(limit - marker.length - head))
  );
}
