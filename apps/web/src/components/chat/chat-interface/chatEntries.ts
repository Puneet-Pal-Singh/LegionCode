import type { Message } from "@ai-sdk/react";
import {
  buildConversationTurns,
  readCanonicalTurnId,
} from "../messageMetadata";
import type { LifecycleProjection } from "@legioncode/sdk";

export type ChatInterfaceEntry =
  | {
      kind: "message";
      message: Message;
      projection?: LifecycleProjection;
    }
  | {
      kind: "workflow";
      key: string;
      turnId: string;
      projection: LifecycleProjection;
      assistantMessage?: Message;
    };

export function buildChatEntries(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
  projectionsByTurnId: Readonly<Record<string, LifecycleProjection>> = {},
  activeTurnId?: string | null,
): ChatInterfaceEntry[] {
  const entries: ChatInterfaceEntry[] = [];
  const emittedWorkflowTurnIds = new Set<string>();
  for (const conversationTurn of conversationTurns) {
    const turnId = conversationTurn.turnId;
    const projection = turnId ? projectionsByTurnId[turnId] : undefined;
    if (conversationTurn.userMessage) {
      entries.push({
        kind: "message",
        message: conversationTurn.userMessage,
        ...(projection ? { projection } : {}),
      });
    }
    if (
      turnId &&
      projection &&
      projection.lastSequence > 0 &&
      !emittedWorkflowTurnIds.has(turnId)
    ) {
      entries.push({
        kind: "workflow",
        key: `workflow:${turnId}`,
        turnId,
        projection,
        ...(representativeAssistant(conversationTurn.assistantMessages ?? [])
          ? {
              assistantMessage: representativeAssistant(
                conversationTurn.assistantMessages ?? [],
              ),
            }
          : {}),
      });
      emittedWorkflowTurnIds.add(turnId);
    }
    for (const assistantMessage of conversationTurn.assistantMessages ?? []) {
      if (shouldIncludeAssistantMessage(assistantMessage, projection)) {
        entries.push({
          kind: "message",
          message: assistantMessage,
          ...(projection ? { projection } : {}),
        });
      }
    }
  }
  const orphanedActiveProjection = activeTurnId
    ? projectionsByTurnId[activeTurnId]
    : undefined;
  if (
    orphanedActiveProjection &&
    orphanedActiveProjection.lastSequence > 0 &&
    !emittedWorkflowTurnIds.has(orphanedActiveProjection.turnId)
  ) {
    entries.push({
      kind: "workflow",
      key: `workflow:${orphanedActiveProjection.turnId}`,
      turnId: orphanedActiveProjection.turnId,
      projection: orphanedActiveProjection,
    });
  }
  return entries;
}

function representativeAssistant(messages: Message[]): Message | undefined {
  return (
    [...messages]
      .reverse()
      .find(
        (message) => readMessageMetadata(message)?.phase === "final_answer",
      ) ?? messages[messages.length - 1]
  );
}

function shouldIncludeAssistantMessage(
  message: Message | undefined,
  projection?: LifecycleProjection,
): message is Message {
  if (!message || message.role !== "assistant") return false;
  return !isRepresentedByWorkflow(message, projection);
}

function isRepresentedByWorkflow(
  message: Message,
  projection?: LifecycleProjection,
): boolean {
  if (!projection || readCanonicalTurnId(message) !== projection.turnId)
    return false;
  const metadata = readMessageMetadata(message);
  const itemId = metadata?.itemId;
  if (typeof itemId !== "string") return false;
  const phase = metadata?.phase;
  const messageContent = message.content.trim();
  if (!messageContent) return false;
  if (phase === "commentary") {
    return projection.items.some(
      (item) =>
        item.kind === "commentary" &&
        item.itemId === itemId &&
        item.text.trim() === messageContent,
    );
  }
  if (phase !== "final_answer") return false;
  const item = projection.items.find(
    (candidate) =>
      candidate.kind === "assistant_message" && candidate.itemId === itemId,
  );
  if (!item || !item.text.trim().startsWith(messageContent)) return false;
  const renderedFinalText =
    projection.terminal?.state === "completed"
      ? projection.assistantText || projection.terminal.content
      : projection.assistantText;
  return renderedFinalText.includes(messageContent);
}

function readMessageMetadata(message: Message): Record<string, unknown> | null {
  const data = (message as Message & { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const metadata = (data as Record<string, unknown>).metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}
