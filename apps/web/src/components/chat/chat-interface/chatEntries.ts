import type { Message } from "@ai-sdk/react";
import { buildConversationTurns } from "../messageMetadata";
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";

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
    if (conversationTurn.userMessage) {
      entries.push({ kind: "message", message: conversationTurn.userMessage });
    }
    const turnId = conversationTurn.turnId;
    const projection = turnId ? projectionsByTurnId[turnId] : undefined;
    if (turnId && projection && projection.lastSequence > 0) {
      entries.push({
        kind: "workflow",
        key: `workflow:${turnId}`,
        turnId,
        projection,
        ...(conversationTurn.assistantMessage
          ? { assistantMessage: conversationTurn.assistantMessage }
          : {}),
      });
      emittedWorkflowTurnIds.add(turnId);
    }
    if (
      shouldIncludeAssistantMessage(
        conversationTurn.assistantMessage,
        projection,
      )
    ) {
      entries.push({
        kind: "message",
        message: conversationTurn.assistantMessage,
        ...(projection ? { projection } : {}),
      });
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

function shouldIncludeAssistantMessage(
  message: Message | undefined,
  projection?: LifecycleProjection,
): message is Message {
  if (!message || message.role !== "assistant") return false;
  if (
    projection?.terminal?.state === "completed" &&
    (projection.assistantText.trim() || projection.terminal.content.trim())
  ) {
    return false;
  }
  const terminalState = readTerminalState(message);
  return terminalState == null || terminalState === "completed";
}

function readTerminalState(message: Message): string | null {
  const data = (message as Message & { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const metadata = (data as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const terminalState = (metadata as Record<string, unknown>).terminalState;
  return typeof terminalState === "string" ? terminalState : null;
}
