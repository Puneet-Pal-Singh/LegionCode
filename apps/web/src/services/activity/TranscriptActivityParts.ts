import type { Message } from "@ai-sdk/react";
import {
  isTurnActivityTranscriptPart,
  type TurnActivityEvent,
  type TurnActivityTranscriptPart,
} from "@repo/shared-types";
import type {
  ActivityFeedRowViewModel,
  ActivityTurnViewModel,
} from "./ActivityFeedViewModel.js";

export function buildTranscriptActivityTurns(
  messages: Message[],
): ActivityTurnViewModel[] {
  const turns: ActivityTurnViewModel[] = [];
  let userPrompt: string | null = null;

  for (const message of messages) {
    if (message.role === "user" && message.content.trim()) {
      userPrompt = message.content;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const activityParts = readActivityParts(message);
    if (activityParts.length === 0) {
      continue;
    }

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
    const existingTurn = merged.get(turn.key);
    merged.set(
      turn.key,
      existingTurn ? choosePreferredTurn(existingTurn, turn) : turn,
    );
  }
  return [...merged.values()];
}

function readActivityParts(message: Message): TurnActivityTranscriptPart[] {
  const data = readMessageData(message);
  if (!isActivityData(data)) {
    return [];
  }
  return data.activityParts.filter(isTurnActivityTranscriptPart);
}

function readMessageData(message: Message): unknown {
  return (message as { data?: unknown }).data;
}

function isActivityData(value: unknown): value is { activityParts: unknown[] } {
  return (
    value !== null &&
    typeof value === "object" &&
    "activityParts" in value &&
    Array.isArray((value as { activityParts?: unknown }).activityParts)
  );
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
    const sortedEvents = [...events].sort(
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

function choosePreferredTurn(
  existing: ActivityTurnViewModel,
  candidate: ActivityTurnViewModel,
): ActivityTurnViewModel {
  const existingScore = scoreActivityTurn(existing);
  const candidateScore = scoreActivityTurn(candidate);
  if (candidateScore > existingScore) {
    return candidate;
  }
  return existing;
}

function scoreActivityTurn(turn: ActivityTurnViewModel): number {
  const settledRows = turn.rows.filter(isSettledActivityRow).length;
  const providerErrors = turn.rows.filter(isProviderUnavailableRow).length;
  return turn.rows.length * 10 + settledRows * 2 + providerErrors * 5;
}

function isSettledActivityRow(row: ActivityFeedRowViewModel): boolean {
  if (row.kind === "tool" || row.kind === "group") {
    return row.status === "completed" || row.status === "failed";
  }
  if (row.kind === "reasoning" || row.kind === "commentary") {
    return row.status === "completed";
  }
  return true;
}

function isProviderUnavailableRow(row: ActivityFeedRowViewModel): boolean {
  return (
    row.kind === "commentary" && row.metadata?.code === "PROVIDER_UNAVAILABLE"
  );
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
