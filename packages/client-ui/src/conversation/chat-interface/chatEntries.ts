import type { Message } from "@ai-sdk/react";
import { buildConversationTurns, readCanonicalTurnId } from "@legioncode/sdk";
import type { LifecycleProjection } from "@legioncode/sdk";

/** Validated history-snapshot facts supplied by the host, never inferred from a window. */
export interface CanonicalConversationTurnBounds {
  readonly rootUserMessageId: string;
  readonly lastUserMessageId: string;
}
export type CanonicalConversationBounds = Readonly<Record<string, CanonicalConversationTurnBounds>>;

export type ChatInterfaceEntry =
  | {
      kind: "message";
      message: Message;
      projection?: LifecycleProjection;
      editTargetTurnId?: string;
      editTargetTerminal?: boolean;
      editUnavailable?: boolean;
      historyStatus?: "revised" | "edited";
    }
  | {
      kind: "workflow";
      key: string;
      turnId: string;
      projection: LifecycleProjection;
      assistantMessage?: Message;
      workflowHistory?: Extract<ChatInterfaceEntry, { kind: "workflow" }>[];
      historyStatus?: "revised" | "edited";
    };

export function buildChatEntries(
  conversationTurns: ReturnType<typeof buildConversationTurns<Message>>,
  projectionsByTurnId: Readonly<Record<string, LifecycleProjection>> = {},
  activeTurnId?: string | null,
  canonicalBoundsByTurnId?: CanonicalConversationBounds,
): ChatInterfaceEntry[] {
  const entries: ChatInterfaceEntry[] = [];
  const emittedWorkflowTurnIds = new Set<string>();
  const bounded = canonicalBoundsByTurnId !== undefined;
  const boundsByTurnId = new Map(Object.entries(canonicalBoundsByTurnId ?? {}));
  type ConversationTurn = (typeof conversationTurns)[number];
  const workflowAnchorByTurnId = new Map<string, ConversationTurn>();
  const rootPromptByTurnId = new Map<string, string>();
  const assistantsByTurnId = new Map<string, Message[]>();
  for (const turn of conversationTurns) {
    if (!turn.turnId) continue;
    const bounds = boundsByTurnId.get(turn.turnId);
    if (bounded) {
      if (bounds) rootPromptByTurnId.set(turn.turnId, bounds.rootUserMessageId);
      if (bounds && turn.userMessage?.id === bounds.lastUserMessageId) {
        workflowAnchorByTurnId.set(turn.turnId, turn);
      }
    } else if (turn.userMessage) {
      // Complete transcripts can derive their root; a bounded window cannot.
      if (!rootPromptByTurnId.has(turn.turnId)) {
        rootPromptByTurnId.set(turn.turnId, turn.userMessage.id);
      }
      workflowAnchorByTurnId.set(turn.turnId, turn);
    } else if (!workflowAnchorByTurnId.has(turn.turnId)) {
      workflowAnchorByTurnId.set(turn.turnId, turn);
    }
    const assistants = assistantsByTurnId.get(turn.turnId) ?? [];
    assistants.push(...(turn.assistantMessages ?? []));
    assistantsByTurnId.set(turn.turnId, assistants);
  }
  const entriesByTurn = new Map<
    (typeof conversationTurns)[number],
    ChatInterfaceEntry[]
  >();
  for (const conversationTurn of conversationTurns) {
    const turnId = conversationTurn.turnId;
    const projection = turnId ? projectionsByTurnId[turnId] : undefined;
    const hasWorkflow = Boolean(turnId && projection && projection.lastSequence > 0 &&
      workflowAnchorByTurnId.has(turnId));
    const turnEntries: ChatInterfaceEntry[] = [];
    if (conversationTurn.userMessage) {
      turnEntries.push({
        kind: "message",
        message: conversationTurn.userMessage,
        ...(projection ? { projection } : {}),
        ...(projection?.revisionOfTurnId ? { historyStatus: "edited" } : {}),
        ...(turnId && rootPromptByTurnId.get(turnId) !== conversationTurn.userMessage.id
          ? { editUnavailable: true } : {}),
      });
    }
    if (
      turnId &&
      projection &&
      projection.lastSequence > 0 &&
      workflowAnchorByTurnId.get(turnId) === conversationTurn &&
      !emittedWorkflowTurnIds.has(turnId)
    ) {
      const assistantMessage = representativeAssistant(
        assistantsByTurnId.get(turnId) ?? [],
      );
      turnEntries.push({
        kind: "workflow",
        key: `workflow:${turnId}`,
        turnId,
        projection,
        ...(assistantMessage ? { assistantMessage } : {}),
      });
      emittedWorkflowTurnIds.add(turnId);
    }
    for (const assistantMessage of conversationTurn.assistantMessages ?? []) {
      if (shouldIncludeAssistantMessage(assistantMessage, hasWorkflow ? projection : undefined)) {
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
  const revisedPromptIds = findRevisedPromptIds(
    conversationTurns,
    projectionsByTurnId,
    boundsByTurnId,
    bounded,
  );
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
      ...(activeProjection.lastSequence > 0 && !bounded
        ? [createWorkflowEntry(activeProjection)]
        : []),
    ]);
    latestContinuationByPromptId.set(
      activeProjection.originalPromptId,
      activeProjection,
    );
    if (activeProjection.lastSequence > 0 && !bounded) {
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
    const isContinuation = Boolean(projection?.continuationOfTurnId);
    const promptId =
      (conversationTurn.turnId
        ? rootPromptByTurnId.get(conversationTurn.turnId)
        : undefined) ?? (bounded ? undefined : conversationTurn.userMessage?.id);
    const turnEntries = (entriesByTurn.get(conversationTurn) ?? []).map(
      (entry) =>
        isTurnInRevisedBranch(
          projection?.originalPromptId ?? promptId,
          revisedPromptIds,
        )
          ? { ...entry, historyStatus: "revised" as const }
          : entry,
    );
    if (isContinuation) continue;
    const latestContinuation = promptId
      ? latestContinuationByPromptId.get(promptId)
      : undefined;
    const continuationEntries = promptId
      ? continuationEntriesByPromptId.get(promptId)
      : undefined;
    const continuationAnchor = !conversationTurn.turnId ||
      workflowAnchorByTurnId.get(conversationTurn.turnId) === conversationTurn;
    const withEditTarget = (entry: ChatInterfaceEntry): ChatInterfaceEntry =>
      latestContinuation && entry.kind === "message" &&
      entry.message.role === "user" && entry.message.id === promptId
        ? {
            ...entry,
            editTargetTurnId: latestContinuation.turnId,
            editTargetTerminal: Boolean(latestContinuation.terminal),
          }
        : entry;
    if (latestContinuation && continuationEntries && continuationAnchor) {
      const allEntries = [...turnEntries, ...continuationEntries];
      const groupedEntries = groupWorkflowContinuations(
        allEntries,
        latestContinuation.turnId,
      );
      entries.push(
        ...groupedEntries.map((entry) => {
          const revisedEntry = markRevisedHistory(
            entry,
            promptId ?? latestContinuation.originalPromptId ?? "",
            revisedPromptIds,
          );
          return withEditTarget(revisedEntry);
        }),
      );
    } else {
      entries.push(...turnEntries.map(withEditTarget));
      if (continuationEntries && continuationAnchor) {
        entries.push(
          ...continuationEntries.map((entry) =>
            isTurnInRevisedBranch(promptId, revisedPromptIds)
              ? { ...entry, historyStatus: "revised" as const }
              : entry,
          ),
        );
      }
    }
    if (promptId && continuationAnchor) continuationEntriesByPromptId.delete(promptId);
  }
  for (const [promptId, remaining] of continuationEntriesByPromptId) {
    const latestContinuation = latestContinuationByPromptId.get(promptId);
    const groupedEntries = latestContinuation
      ? groupWorkflowContinuations(remaining, latestContinuation.turnId)
      : remaining;
    entries.push(
      ...groupedEntries.map((entry) =>
        markRevisedHistory(entry, promptId, revisedPromptIds),
      ),
    );
  }
  const orphanedActiveProjection = activeTurnId
    ? projectionsByTurnId[activeTurnId]
    : undefined;
  if (
    orphanedActiveProjection &&
    orphanedActiveProjection.lastSequence > 0 &&
    !bounded &&
    !emittedWorkflowTurnIds.has(orphanedActiveProjection.turnId)
  ) {
    entries.push(createWorkflowEntry(orphanedActiveProjection));
  }
  return entries;
}

function markRevisedHistory<T extends ChatInterfaceEntry>(
  entry: T,
  promptId: string,
  revisedPromptIds: ReadonlySet<string>,
): T {
  const revisedEntry = isTurnInRevisedBranch(
    entry.projection?.originalPromptId ?? promptId,
    revisedPromptIds,
  )
    ? { ...entry, historyStatus: "revised" as const }
    : entry;
  if (revisedEntry.kind !== "workflow" || !revisedEntry.workflowHistory) {
    return revisedEntry as T;
  }
  return {
    ...revisedEntry,
    workflowHistory: revisedEntry.workflowHistory.map((historicalEntry) =>
      markRevisedHistory(historicalEntry, promptId, revisedPromptIds),
    ),
  } as T;
}

function groupWorkflowContinuations(
  entries: ChatInterfaceEntry[],
  latestTurnId: string,
): ChatInterfaceEntry[] {
  const latestWorkflowExists = entries.some(
    (entry) => entry.kind === "workflow" && entry.turnId === latestTurnId,
  );
  if (!latestWorkflowExists) return entries;

  const workflowHistory = entries
    .filter(
      (entry): entry is Extract<ChatInterfaceEntry, { kind: "workflow" }> =>
        entry.kind === "workflow" && entry.turnId !== latestTurnId,
    )
    .map((entry, index) => ({
      entry,
      index,
      startedAt: Date.parse(entry.projection.startedAt ?? ""),
    }))
    .sort((left, right) => {
      const leftStart = Number.isNaN(left.startedAt)
        ? Number.POSITIVE_INFINITY
        : left.startedAt;
      const rightStart = Number.isNaN(right.startedAt)
        ? Number.POSITIVE_INFINITY
        : right.startedAt;
      return leftStart - rightStart || left.index - right.index;
    })
    .map(({ entry }) => entry);
  return entries
    .filter(
      (entry) => entry.kind !== "workflow" || entry.turnId === latestTurnId,
    )
    .map((entry) =>
      entry.kind === "workflow" ? { ...entry, workflowHistory } : entry,
    );
}

function findRevisedPromptIds(
  conversationTurns: ReturnType<typeof buildConversationTurns<Message>>,
  projectionsByTurnId: Readonly<Record<string, LifecycleProjection>>,
  boundsByTurnId: ReadonlyMap<string, CanonicalConversationTurnBounds>,
  bounded: boolean,
): Set<string> {
  const revisedPromptIds = new Set<string>();
  for (const projection of Object.values(projectionsByTurnId)) {
    if (!projection.revisionOfTurnId) continue;
    const promptId = findLogicalPromptId(
      projection.revisionOfTurnId,
      conversationTurns,
      projectionsByTurnId,
      boundsByTurnId,
      bounded,
    );
    if (promptId) revisedPromptIds.add(promptId);
  }
  return revisedPromptIds;
}

function findLogicalPromptId(
  initialTurnId: string,
  conversationTurns: ReturnType<typeof buildConversationTurns<Message>>,
  projectionsByTurnId: Readonly<Record<string, LifecycleProjection>>,
  boundsByTurnId: ReadonlyMap<string, CanonicalConversationTurnBounds>,
  bounded: boolean,
): string | null {
  const visited = new Set<string>();
  let currentTurnId: string | null = initialTurnId;
  while (currentTurnId && !visited.has(currentTurnId)) {
    visited.add(currentTurnId);
    const targetProjection: LifecycleProjection | undefined =
      projectionsByTurnId[currentTurnId];
    if (
      targetProjection?.originalPromptId &&
      targetProjection.continuationOfTurnId
    ) {
      return targetProjection.originalPromptId;
    }
    if (targetProjection?.revisionOfTurnId) {
      currentTurnId = targetProjection.revisionOfTurnId;
      continue;
    }
    const turn = conversationTurns.find(
      (candidate) => candidate.turnId === currentTurnId,
    );
    return boundsByTurnId.get(currentTurnId)?.rootUserMessageId ??
      (bounded ? null : turn?.userMessage?.id ?? null);
  }
  return null;
}

function isTurnInRevisedBranch(
  rootPromptId: string | undefined,
  revisedPromptIds: ReadonlySet<string>,
): boolean {
  return Boolean(rootPromptId && revisedPromptIds.has(rootPromptId));
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
