import type { Message } from "@ai-sdk/react";
import { buildConversationTurns, resolveMessageTimestamp, type ConversationTurn as CanonicalConversationTurn } from "@legioncode/sdk";
import type { LifecycleProjection } from "@legioncode/sdk";
import type { ChatMessageMetadata } from "@legioncode/client-ui";

interface MessageTimingEvent {
  phase: "request" | "response" | "finish" | "error";
  timestamp: string;
  payload: unknown;
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

type ConversationTurn = CanonicalConversationTurn<Message> & { request?: RequestTiming };

interface RequestTiming {
  modelId?: string;
  startedAtMs: number;
  finishedAtMs?: number;
}

export function buildChatMessageMetadata(
  messages: Message[],
  debugEvents: MessageTimingEvent[],
  resolveModelLabel: (modelId: string) => string,
  modeLabel = "Build",
): Record<string, ChatMessageMetadata> {
  const turns = buildConversationTurns(messages);
  const requests = buildRequestTimings(debugEvents);
  assignRequestsToTurns(turns, requests);
  return mapTurnsToMessageMetadata(turns, resolveModelLabel, modeLabel);
}

function buildRequestTimings(debugEvents: MessageTimingEvent[]): RequestTiming[] {
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
    const durationLabel = formatDuration(resolveTurnDurationMs(turn));

    if (turn.userMessage) {
      metadata[turn.userMessage.id] = {
        modeLabel,
        modelLabel,
        timeLabel: userTimeLabel,
      };
    }
    for (const assistantMessage of turn.assistantMessages ?? []) {
      metadata[assistantMessage.id] = {
        modeLabel,
        modelLabel,
        durationLabel,
        timeLabel: formatTimestamp(
          resolveMessageTimestamp(assistantMessage) ??
            turn.request?.finishedAtMs,
        ),
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
