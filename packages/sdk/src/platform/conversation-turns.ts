import { TurnIdSchema } from "@repo/platform-protocol";

/** Fields consumed by transcript grouping; callers retain their full message type. */
export interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  createdAt?: Date | string;
  data?: unknown;
}

export interface ConversationTurn<
  TMessage extends ConversationMessage = ConversationMessage,
> {
  key: string;
  turnId?: string;
  userMessage?: TMessage;
  assistantMessages?: TMessage[];
  userAtMs?: number;
  assistantAtMs?: number;
}

export function buildConversationTurns<TMessage extends ConversationMessage>(
  messages: TMessage[],
): ConversationTurn<TMessage>[] {
  const turns: ConversationTurn<TMessage>[] = [];
  for (const message of collapseRepeatedMessageIds(messages)) {
    const messageAtMs = resolveMessageTimestamp(message);
    const canonicalTurnId = readCanonicalTurnId(message);
    if (message.role === "user") {
      turns.push({
        key: message.id,
        ...(canonicalTurnId ? { turnId: canonicalTurnId } : {}),
        userMessage: message,
        userAtMs: messageAtMs,
      });
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    const matchingCanonicalUser = canonicalTurnId
      ? turns.find(
          (turn) => turn.userMessage && turn.turnId === canonicalTurnId,
        )
      : undefined;
    if (matchingCanonicalUser) {
      matchingCanonicalUser.assistantMessages ??= [];
      matchingCanonicalUser.assistantMessages.push(message);
      matchingCanonicalUser.assistantAtMs = messageAtMs;
      continue;
    }
    turns.push({
      key: message.id,
      ...(canonicalTurnId ? { turnId: canonicalTurnId } : {}),
      assistantMessages: [message],
      assistantAtMs: messageAtMs,
    });
  }
  return turns;
}

export function readCanonicalTurnId(
  message: ConversationMessage,
): string | null {
  const metadata = readMessageMetadata(message);
  const identity = metadata?.canonicalIdentity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    return null;
  }
  const turnId = (identity as Record<string, unknown>).turnId;
  const parsed = TurnIdSchema.safeParse(turnId);
  return parsed.success ? parsed.data : null;
}

function readMessageMetadata(
  message: ConversationMessage,
): Record<string, unknown> | null {
  const data = message.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const metadata = (data as Record<string, unknown>).metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function collapseRepeatedMessageIds<TMessage extends ConversationMessage>(
  messages: TMessage[],
): TMessage[] {
  const latestById = new Map<string, TMessage>();
  for (const message of messages) {
    latestById.set(message.id, message);
  }

  const emittedIds = new Set<string>();
  const collapsed: TMessage[] = [];
  for (const message of messages) {
    if (emittedIds.has(message.id)) {
      continue;
    }
    emittedIds.add(message.id);
    collapsed.push(latestById.get(message.id) ?? message);
  }
  return collapsed;
}

export function resolveMessageTimestamp(
  message: ConversationMessage,
): number | undefined {
  const createdAt = message.createdAt;
  if (createdAt instanceof Date && !Number.isNaN(createdAt.getTime())) {
    return createdAt.getTime();
  }
  if (typeof createdAt === "string") {
    const parsed = Date.parse(createdAt);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
