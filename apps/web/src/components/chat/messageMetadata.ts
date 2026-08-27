import type { Message } from "@ai-sdk/react";
import type { ChatDebugEvent } from "../../types/chat-debug.js";
import { TurnIdSchema } from "@repo/platform-client-sdk";
import type { LifecycleProjection } from "../../services/lifecycle/LifecycleProjection";

export interface ChatMessageMetadata {
  modeLabel: string;
  modelLabel?: string;
  durationLabel?: string;
  timeLabel?: string;
}

export function buildLifecycleMessageMetadata(
  projection: LifecycleProjection,
  fallback: ChatMessageMetadata | undefined,
  resolveModelLabel: (modelId: string) => string,
  modeLabel: string,
): ChatMessageMetadata {
  const startedAtMs = parseTimestamp(projection.startedAt);
  const settledAtMs = parseTimestamp(
    projection.settledAt ?? projection.terminal?.occurredAt ?? null,
  );
  return {
    modeLabel: fallback?.modeLabel ?? modeLabel,
    modelLabel: projection.usage?.modelId
      ? resolveModelLabel(projection.usage.modelId)
      : fallback?.modelLabel,
    durationLabel:
      fallback?.durationLabel ??
      formatDuration(
        startedAtMs && settledAtMs && settledAtMs >= startedAtMs
          ? settledAtMs - startedAtMs
          : undefined,
      ),
    timeLabel: fallback?.timeLabel ?? formatTimestamp(settledAtMs),
  };
}

export interface ConversationTurn {
  key: string;
  turnId?: string;
  userMessage?: Message;
  assistantMessage?: Message;
  userAtMs?: number;
  assistantAtMs?: number;
  request?: RequestTiming;
}

interface RequestTiming {
  modelId?: string;
  startedAtMs: number;
  finishedAtMs?: number;
}

export function buildChatMessageMetadata(
  messages: Message[],
  debugEvents: ChatDebugEvent[],
  resolveModelLabel: (modelId: string) => string,
  modeLabel = "Build",
): Record<string, ChatMessageMetadata> {
  const turns = buildConversationTurns(messages);
  const requests = buildRequestTimings(debugEvents);
  assignRequestsToTurns(turns, requests);
  return mapTurnsToMessageMetadata(turns, resolveModelLabel, modeLabel);
}

export function buildConversationTurns(
  messages: Message[],
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let turnIndex = 0;
  for (const message of collapseRepeatedMessageIds(messages)) {
    const messageAtMs = resolveMessageTimestamp(message);
    const canonicalTurnId = readCanonicalTurnId(message);
    if (message.role === "user") {
      turnIndex += 1;
      turns.push({
        key: message.id,
        turnId: canonicalTurnId ?? `turn-${turnIndex}`,
        userMessage: message,
        userAtMs: messageAtMs,
      });
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    if (readMessagePhase(message) === "commentary") {
      continue;
    }
    const latestUserTurn =
      findConversationTurnByCanonicalId(turns, canonicalTurnId) ??
      findLatestUserConversationTurn(turns);
    if (latestUserTurn) {
      if (canonicalTurnId) {
        latestUserTurn.turnId = canonicalTurnId;
      }
      latestUserTurn.assistantMessage = message;
      latestUserTurn.assistantAtMs = messageAtMs;
      continue;
    }
    turns.push({
      key: message.id,
      assistantMessage: message,
      assistantAtMs: messageAtMs,
    });
  }
  return turns;
}

export function readCanonicalTurnId(message: Message): string | null {
  const metadata = readMessageMetadata(message);
  const identity = metadata?.canonicalIdentity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    return null;
  }
  const turnId = (identity as Record<string, unknown>).turnId;
  const parsed = TurnIdSchema.safeParse(turnId);
  return parsed.success ? parsed.data : null;
}

function readMessagePhase(message: Message): string | null {
  const phase = readMessageMetadata(message)?.phase;
  return typeof phase === "string" ? phase : null;
}

function readMessageMetadata(message: Message): Record<string, unknown> | null {
  const data = (message as Message & { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const metadata = (data as Record<string, unknown>).metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function findConversationTurnByCanonicalId(
  turns: ConversationTurn[],
  turnId: string | null,
): ConversationTurn | undefined {
  return turnId ? turns.find((turn) => turn.turnId === turnId) : undefined;
}

function collapseRepeatedMessageIds(messages: Message[]): Message[] {
  const latestById = new Map<string, Message>();
  for (const message of messages) {
    latestById.set(message.id, message);
  }

  const emittedIds = new Set<string>();
  const collapsed: Message[] = [];
  for (const message of messages) {
    if (emittedIds.has(message.id)) {
      continue;
    }
    emittedIds.add(message.id);
    collapsed.push(latestById.get(message.id) ?? message);
  }
  return collapsed;
}

function findLatestUserConversationTurn(
  turns: ConversationTurn[],
): ConversationTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.userMessage) {
      return turns[i];
    }
  }
  return undefined;
}

function buildRequestTimings(debugEvents: ChatDebugEvent[]): RequestTiming[] {
  const chronological = [...debugEvents].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  const requests: RequestTiming[] = [];
  const finishes: number[] = [];

  for (const event of chronological) {
    if (event.phase === "request") {
      requests.push({
        modelId: extractModelIdFromDebugPayload(event.payload),
        startedAtMs: Date.parse(event.timestamp),
      });
      continue;
    }
    if (event.phase === "finish") {
      finishes.push(Date.parse(event.timestamp));
    }
  }

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const finishAtMs = finishes[index];
    if (!request || !finishAtMs || Number.isNaN(finishAtMs)) {
      continue;
    }
    request.finishedAtMs = finishAtMs;
  }

  return requests;
}

function extractModelIdFromDebugPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const resolvedConfig =
    record.resolvedConfig && typeof record.resolvedConfig === "object"
      ? (record.resolvedConfig as Record<string, unknown>)
      : null;
  const requestBody =
    record.requestBody && typeof record.requestBody === "object"
      ? (record.requestBody as Record<string, unknown>)
      : null;

  const resolvedModelId = resolvedConfig?.modelId;
  if (typeof resolvedModelId === "string" && resolvedModelId.trim()) {
    return resolvedModelId;
  }

  const requestModelId = requestBody?.modelId;
  if (typeof requestModelId === "string" && requestModelId.trim()) {
    return requestModelId;
  }

  return undefined;
}

function assignRequestsToTurns(
  turns: ConversationTurn[],
  requests: RequestTiming[],
): void {
  let requestIndex = 0;
  for (const turn of turns) {
    if (!turn.userMessage) {
      continue;
    }
    const request = requests[requestIndex];
    if (request) {
      turn.request = request;
      requestIndex += 1;
    }
  }
}

function mapTurnsToMessageMetadata(
  turns: ConversationTurn[],
  resolveModelLabel: (modelId: string) => string,
  modeLabel: string,
): Record<string, ChatMessageMetadata> {
  const metadata: Record<string, ChatMessageMetadata> = {};
  for (const turn of turns) {
    const modelLabel = turn.request?.modelId
      ? resolveModelLabel(turn.request.modelId)
      : undefined;
    const userTimeLabel = formatTimestamp(
      turn.userAtMs ?? turn.request?.startedAtMs,
    );
    const assistantTimeLabel = formatTimestamp(
      turn.assistantAtMs ?? turn.request?.finishedAtMs,
    );
    const durationLabel = formatDuration(resolveTurnDurationMs(turn));

    if (turn.userMessage) {
      metadata[turn.userMessage.id] = {
        modeLabel,
        modelLabel,
        timeLabel: userTimeLabel,
      };
    }
    if (turn.assistantMessage) {
      metadata[turn.assistantMessage.id] = {
        modeLabel,
        modelLabel,
        durationLabel,
        timeLabel: assistantTimeLabel,
      };
    }
  }
  return metadata;
}

function resolveTurnDurationMs(turn: ConversationTurn): number | undefined {
  if (
    turn.userAtMs &&
    turn.assistantAtMs &&
    turn.assistantAtMs >= turn.userAtMs
  ) {
    return turn.assistantAtMs - turn.userAtMs;
  }
  if (
    turn.request?.finishedAtMs &&
    turn.request.startedAtMs &&
    turn.request.finishedAtMs >= turn.request.startedAtMs
  ) {
    return turn.request.finishedAtMs - turn.request.startedAtMs;
  }
  return undefined;
}

function resolveMessageTimestamp(message: Message): number | undefined {
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

function formatTimestamp(timestampMs?: number): string | undefined {
  if (!timestampMs) {
    return undefined;
  }
  const localizedTime = new Date(timestampMs).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return localizedTime.replace(/\b(a\.?m\.?|p\.?m\.?)\b/gi, (meridiem) =>
    meridiem.toUpperCase(),
  );
}

function parseTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function formatDuration(durationMs?: number): string | undefined {
  if (!durationMs || durationMs <= 0) {
    return undefined;
  }
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `${seconds}s`;
}
