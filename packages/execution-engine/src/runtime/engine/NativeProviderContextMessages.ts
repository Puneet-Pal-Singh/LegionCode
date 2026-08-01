import type { CoreMessage } from "ai";

export function buildProviderContextMessages(input: {
  messages: readonly CoreMessage[];
  compactedContext: string | null;
}): CoreMessage[] {
  if (!input.compactedContext) {
    return [...input.messages];
  }
  const latestUserMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");
  return [
    {
      role: "system",
      content: `Compacted conversation context:\n${input.compactedContext}`,
    },
    ...(latestUserMessage ? [latestUserMessage] : []),
  ];
}

export function estimateConversationTokens(
  messages: readonly CoreMessage[],
): number {
  return Math.max(1, Math.ceil(JSON.stringify(messages).length / 4));
}

export function summarizeConversationForCompaction(
  messages: readonly CoreMessage[],
  prompt: string,
): string {
  const transcript = messages
    .map((message) => `${message.role}: ${readMessageText(message)}`)
    .filter((line) => line.trim().length > 0)
    .join("\n");
  const boundedTranscript =
    transcript.length > 12_000
      ? transcript.slice(transcript.length - 12_000)
      : transcript;
  return [
    `Active user request: ${prompt}`,
    "Preserved conversation transcript:",
    boundedTranscript,
  ].join("\n");
}

function readMessageText(message: CoreMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}
