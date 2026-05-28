import type { Message } from "@ai-sdk/react";
import type {
  TurnActivityEvent,
  TurnActivityTranscriptPart,
} from "@repo/shared-types";
import type {
  ActivityFeedRowViewModel,
  ActivityTurnViewModel,
} from "./ActivityFeedViewModel.js";

interface MessageWithActivityData extends Omit<Message, "data"> {
  data?: unknown;
}

export function buildTranscriptActivityTurns(
  messages: Message[],
): ActivityTurnViewModel[] {
  const turns: ActivityTurnViewModel[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }

    const activityParts = readActivityParts(message);
    if (activityParts.length === 0) {
      continue;
    }

    const userPrompt = findPreviousUserPrompt(messages, index);
    turns.push(
      ...activityParts.flatMap((part) => buildTurns(part, userPrompt)),
    );
  }

  return turns;
}

export function mergeTranscriptAndLiveActivityTurns(
  transcriptTurns: ActivityTurnViewModel[],
  liveTurns: ActivityTurnViewModel[],
): ActivityTurnViewModel[] {
  const merged = new Map<string, ActivityTurnViewModel>();
  for (const turn of transcriptTurns) {
    merged.set(turn.key, turn);
  }
  for (const turn of liveTurns) {
    merged.set(turn.key, turn);
  }
  return [...merged.values()];
}

function readActivityParts(message: Message): TurnActivityTranscriptPart[] {
  const data = (message as MessageWithActivityData).data;
  if (!isActivityData(data)) {
    return [];
  }
  return data.activityParts.filter(isTurnActivityTranscriptPart);
}

function isActivityData(value: unknown): value is { activityParts: unknown[] } {
  return (
    value !== null &&
    typeof value === "object" &&
    "activityParts" in value &&
    Array.isArray((value as { activityParts?: unknown }).activityParts)
  );
}

function isTurnActivityTranscriptPart(
  value: unknown,
): value is TurnActivityTranscriptPart {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TurnActivityTranscriptPart>;
  return (
    candidate.version === 1 &&
    candidate.type === "turn_activity" &&
    Array.isArray(candidate.events)
  );
}

function findPreviousUserPrompt(
  messages: Message[],
  startIndex: number,
): string | null {
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.content.trim()) {
      return message.content;
    }
  }
  return null;
}

function buildTurns(
  part: TurnActivityTranscriptPart,
  userPrompt: string | null,
): ActivityTurnViewModel[] {
  const grouped = new Map<string, TurnActivityEvent[]>();
  for (const event of part.events) {
    const events = grouped.get(event.turnId) ?? [];
    events.push(event);
    grouped.set(event.turnId, events);
  }

  return [...grouped.entries()].map(([turnId, events]) => {
    const sortedEvents = events.sort(
      (left, right) => left.sequence - right.sequence,
    );
    const rows = sortedEvents.map(eventToRow);
    const hasProviderError = rows.some(
      (row) =>
        row.kind === "commentary" &&
        row.metadata?.code === "PROVIDER_UNAVAILABLE",
    );
    return {
      key: turnId,
      userPrompt,
      elapsedLabel: formatTurnElapsed(sortedEvents),
      summaryLabel: buildSummaryLabel(rows),
      defaultCollapsed: !hasProviderError,
      isActiveTurn: false,
      hasVisibleRows: rows.length > 0,
      rows,
    };
  });
}

function eventToRow(event: TurnActivityEvent): ActivityFeedRowViewModel {
  if (event.kind === "provider_error") {
    return {
      kind: "commentary",
      key: event.id,
      phase: "commentary",
      status: "completed",
      text: event.detail ?? event.title,
      metadata: event.metadata,
    };
  }

  if (event.kind === "tool_call" || event.kind === "tool_result") {
    return {
      kind: "tool",
      key: event.id,
      toolName: readMetadataString(event.metadata, "toolName") ?? event.title,
      family: "generic",
      title: event.title,
      summary: event.detail ?? event.title,
      status: mapToolStatus(event.status),
      defaultCollapsed: event.displayMode !== "visible",
      details: event.detail ? [event.detail] : [],
    };
  }

  return {
    kind: "reasoning",
    key: event.id,
    label: event.title,
    summary: event.detail ?? event.title,
    status: event.status === "running" ? "active" : "completed",
  };
}

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function mapToolStatus(
  status: TurnActivityEvent["status"],
): Extract<ActivityFeedRowViewModel, { kind: "tool" }>["status"] {
  if (status === "failed") {
    return "failed";
  }
  if (status === "running") {
    return "running";
  }
  if (status === "pending") {
    return "requested";
  }
  return "completed";
}

function formatTurnElapsed(events: TurnActivityEvent[]): string {
  const first = events[0]?.createdAt;
  const last = events[events.length - 1]?.updatedAt;
  if (!first || !last) {
    return "Activity";
  }
  const elapsedMs = Math.max(0, Date.parse(last) - Date.parse(first));
  if (elapsedMs < 1_000) {
    return "Just now";
  }
  return `${Math.round(elapsedMs / 1_000)}s`;
}

function buildSummaryLabel(rows: ActivityFeedRowViewModel[]): string {
  const providerErrors = rows.filter(
    (row) =>
      row.kind === "commentary" &&
      row.metadata?.code === "PROVIDER_UNAVAILABLE",
  );
  if (providerErrors.length > 0) {
    return "Paused after provider interruption";
  }
  return `${rows.length} activity ${rows.length === 1 ? "row" : "rows"}`;
}
