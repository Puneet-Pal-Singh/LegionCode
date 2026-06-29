import type { Message } from "@ai-sdk/react";
import {
  isTurnActivityTranscriptPart,
  parseActivityFeedSnapshot,
  type ActivityFeedSnapshot,
  type TurnActivityEvent,
  type TurnActivityTranscriptPart,
} from "@repo/shared-types";
import {
  buildActivityFeedViewModel,
  type ActivityFeedViewModel,
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
  const snapshotTurns = buildSnapshotTurns(part);
  if (snapshotTurns) {
    return snapshotTurns;
  }

  const grouped = new Map<string, TurnActivityEvent[]>();
  for (const event of part.events) {
    const events = grouped.get(event.turnId) ?? [];
    events.push(event);
    grouped.set(event.turnId, events);
  }

  return [...grouped.entries()].flatMap(([turnId, events]) => {
    const sortedEvents = [...events].sort(
      (left, right) => left.sequence - right.sequence,
    );
    const rows = dedupeTranscriptRows(
      sortedEvents.flatMap((event) => {
        const row = eventToRow(event);
        return row ? [row] : [];
      }),
    );
    const hasProviderError = rows.some(
      (row) =>
        row.kind === "commentary" &&
        row.metadata?.code === "PROVIDER_UNAVAILABLE",
    );
    return [
      {
        key: turnId,
        userPrompt,
        elapsedLabel: formatTurnElapsed(sortedEvents),
        summaryLabel: buildSummaryLabel(rows),
        defaultCollapsed: !hasProviderError,
        isActiveTurn: false,
        hasVisibleRows: true,
        rows,
      },
    ];
  });
}

function buildSnapshotTurns(
  part: TurnActivityTranscriptPart,
): ActivityFeedViewModel["turns"] | null {
  const snapshot = readActivitySnapshot(part);
  if (!snapshot) {
    return null;
  }

  return buildActivityFeedViewModel(snapshot).turns;
}

function readActivitySnapshot(
  part: TurnActivityTranscriptPart,
): ActivityFeedSnapshot | null {
  const snapshot = part.activitySnapshot;
  if (!snapshot) {
    return null;
  }

  try {
    return parseActivityFeedSnapshot(snapshot);
  } catch (error) {
    console.warn(
      "[activity/transcript] Ignoring invalid activity snapshot:",
      error,
    );
    return null;
  }
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

function eventToRow(event: TurnActivityEvent): ActivityFeedRowViewModel | null {
  if (event.displayMode === "debug") {
    return null;
  }

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
    summary: normalizeRowSummary(event.title, event.detail),
    status: event.status === "running" ? "active" : "completed",
  };
}

function normalizeRowSummary(
  title: string,
  detail: string | undefined,
): string {
  const normalizedDetail = detail?.trim() ?? "";
  return normalizedDetail === title.trim() ? "" : normalizedDetail;
}

function dedupeTranscriptRows(
  rows: ActivityFeedRowViewModel[],
): ActivityFeedRowViewModel[] {
  return rows.filter((row, index) => {
    const previous = rows[index - 1];
    return !areEquivalentReasoningRows(previous, row);
  });
}

function areEquivalentReasoningRows(
  left: ActivityFeedRowViewModel | undefined,
  right: ActivityFeedRowViewModel,
): boolean {
  return (
    left?.kind === "reasoning" &&
    right.kind === "reasoning" &&
    left.label.trim() === right.label.trim() &&
    left.summary.trim() === right.summary.trim()
  );
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
    return "Worked";
  }
  const elapsedMs = Math.max(0, Date.parse(last) - Date.parse(first));
  if (elapsedMs < 1_000) {
    return "Worked for 1s";
  }
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0
    ? `Worked for ${seconds}s`
    : `Worked for ${minutes}m ${seconds}s`;
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
  if (rows.length === 0) {
    return "Workflow captured";
  }
  return `${rows.length} activity ${rows.length === 1 ? "row" : "rows"}`;
}
