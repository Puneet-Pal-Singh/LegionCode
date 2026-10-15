import type { Message } from "@ai-sdk/react";
import {
  buildConversationTurns,
  readCanonicalTurnId,
} from "../messageMetadata";
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";

export type ChatInterfaceEntry =
  | {
      kind: "message";
      message: Message;
      projection?: LifecycleProjection;
      editTargetTurnId?: string;
      editTargetTerminal?: boolean;
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
  const entriesByTurn = new Map<
    (typeof conversationTurns)[number],
    ChatInterfaceEntry[]
  >();
  for (const conversationTurn of conversationTurns) {
    const turnId = conversationTurn.turnId;
    const projection = turnId ? projectionsByTurnId[turnId] : undefined;
    const turnEntries: ChatInterfaceEntry[] = [];
    if (conversationTurn.userMessage) {
      turnEntries.push({
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
      turnEntries.push({
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
        turnEntries.push({
          kind: "message",
          message: assistantMessage,
          ...(projection ? { projection } : {}),
        });
      }
    }
    entriesByTurn.set(conversationTurn, turnEntries);
  }
  const continuationEntriesByPromptId = new Map<string, ChatInterfaceEntry[]>();
  const latestContinuationByPromptId = new Map<string, LifecycleProjection>();
  for (const conversationTurn of conversationTurns) {
    const projection = conversationTurn.turnId
      ? projectionsByTurnId[conversationTurn.turnId]
      : undefined;
    if (!projection?.continuationOfTurnId || !projection.originalPromptId) {
      continue;
    }
    continuationEntriesByPromptId.set(projection.originalPromptId, [
      ...(continuationEntriesByPromptId.get(projection.originalPromptId) ?? []),
      ...(entriesByTurn.get(conversationTurn) ?? []),
    ]);
    latestContinuationByPromptId.set(projection.originalPromptId, projection);
  }
  const activeProjection = activeTurnId
    ? projectionsByTurnId[activeTurnId]
    : undefined;
  const activeTurnHasTranscript = conversationTurns.some(
    (turn) => turn.turnId === activeTurnId,
  );
  if (
    activeProjection?.continuationOfTurnId &&
    activeProjection.originalPromptId &&
    !activeTurnHasTranscript
  ) {
    continuationEntriesByPromptId.set(activeProjection.originalPromptId, [
      ...(continuationEntriesByPromptId.get(
        activeProjection.originalPromptId,
      ) ?? []),
      ...(activeProjection.lastSequence > 0
        ? [createWorkflowEntry(activeProjection)]
        : []),
    ]);
    latestContinuationByPromptId.set(
      activeProjection.originalPromptId,
      activeProjection,
    );
    if (activeProjection.lastSequence > 0) {
      emittedWorkflowTurnIds.add(activeProjection.turnId);
    }
  }
  if (
    activeProjection?.continuationOfTurnId &&
    activeProjection.originalPromptId
  ) {
    latestContinuationByPromptId.set(
      activeProjection.originalPromptId,
      activeProjection,
    );
  }
  for (const conversationTurn of conversationTurns) {
    const projection = conversationTurn.turnId
      ? projectionsByTurnId[conversationTurn.turnId]
      : undefined;
    if (projection?.continuationOfTurnId) continue;
    const turnEntries = entriesByTurn.get(conversationTurn) ?? [];
    const latestContinuation = conversationTurn.userMessage
      ? latestContinuationByPromptId.get(conversationTurn.userMessage.id)
      : undefined;
    if (latestContinuation) {
      entries.push(
        ...turnEntries.map((entry) =>
          entry.kind === "message" && entry.message.role === "user"
            ? {
                ...entry,
                editTargetTurnId: latestContinuation.turnId,
                editTargetTerminal: Boolean(
                  latestContinuation.terminal &&
                  (latestContinuation.terminal.state === "interrupted" ||
                    latestContinuation.terminal.state === "failed"),
                ),
              }
            : entry,
        ),
      );
    } else {
      entries.push(...turnEntries);
    }
    const promptId = conversationTurn.userMessage?.id;
    if (!promptId) continue;
    const continuationEntries = continuationEntriesByPromptId.get(promptId);
    if (continuationEntries) {
      entries.push(...continuationEntries);
      continuationEntriesByPromptId.delete(promptId);
    }
  }
  for (const remaining of continuationEntriesByPromptId.values()) {
    entries.push(...remaining);
  }
  const orphanedActiveProjection = activeTurnId
    ? projectionsByTurnId[activeTurnId]
    : undefined;
  if (
    orphanedActiveProjection &&
    orphanedActiveProjection.lastSequence > 0 &&
    !emittedWorkflowTurnIds.has(orphanedActiveProjection.turnId)
  ) {
    entries.push(createWorkflowEntry(orphanedActiveProjection));
  }
  return entries;
}

function createWorkflowEntry(
  projection: LifecycleProjection,
): ChatInterfaceEntry {
  return {
    kind: "workflow",
    key: `workflow:${projection.turnId}`,
    turnId: projection.turnId,
    projection,
  };
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
  const phase = metadata?.phase;
  const messageContent = message.content.trim();
  if (!messageContent) return false;
  if (itemId === undefined || itemId === null) {
    const storedTerminalState = metadata?.terminalState;
    if (
      (phase !== "final_answer" && phase !== "commentary") ||
      projection.lastSequence <= 0 ||
      projection.terminal?.state !== "completed" ||
      (typeof storedTerminalState === "string" &&
        storedTerminalState !== "completed" &&
        storedTerminalState !== "completed_with_warnings")
    ) {
      return false;
    }
    if (phase === "commentary") {
      const renderedCommentary = projection.items
        .filter((item) => item.kind === "commentary")
        .map((item) => item.text)
        .join("")
        .trim();
      return renderedCommentary === messageContent;
    }
    const renderedFinalText =
      projection.assistantText || projection.terminal.content;
    return renderedFinalText.trim() === messageContent;
  }
  if (typeof itemId !== "string") return false;
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
