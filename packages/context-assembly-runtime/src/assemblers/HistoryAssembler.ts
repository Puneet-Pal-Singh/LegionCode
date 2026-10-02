/**
 * HistoryAssembler - Dumb transformation for memory snapshot
 *
 * Single responsibility: Transform memory chunks to context messages
 * No truncation, no decisions, pure transformation
 */
import type {
  MemorySnapshot,
  ContextMessage,
} from "@legioncode/context-assembly";

export function assembleHistory(memory: MemorySnapshot): ContextMessage[] {
  const messages: ContextMessage[] = [];

  // Process all memory chunks (pinned, summaries, recent)
  const allChunks = [
    ...(memory.pinned ?? []),
    ...(memory.summaries ?? []),
    ...(memory.recent ?? []),
  ];

  for (const chunk of allChunks) {
    const metadata: { source?: string; priority?: number } = {};

    if (chunk.source !== undefined) {
      metadata.source = chunk.source;
    }
    if (chunk.importance !== undefined) {
      metadata.priority = chunk.importance;
    }

    messages.push({
      role: "user",
      content: chunk.content,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  return messages;
}
