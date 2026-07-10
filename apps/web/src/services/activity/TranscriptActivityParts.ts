import type { Message } from "@ai-sdk/react";
import {
  type ActivityFeedSnapshot,
  isTurnActivityTranscriptPart,
  parseActivityFeedSnapshot,
  type TurnActivityTranscriptPart,
} from "@repo/shared-types";
import {
  buildActivityFeedViewModel,
  ActivityFeedRowViewModel,
  ActivityTurnViewModel,
} from "./ActivityFeedViewModel.js";

export function buildTranscriptActivityTurns(
  messages: Message[],
): ActivityTurnViewModel[] {
  const turns: ActivityTurnViewModel[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    const activityParts = readActivityParts(message);
    if (activityParts.length === 0) {
      continue;
    }

    turns.push(...activityParts.flatMap(buildTurns));
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

function buildTurns(part: TurnActivityTranscriptPart): ActivityTurnViewModel[] {
  return buildActivityFeedViewModel(
    settleTranscriptActivitySnapshot(
      parseActivityFeedSnapshot(part.activitySnapshot),
    ),
  ).turns;
}

function settleTranscriptActivitySnapshot(
  snapshot: ActivityFeedSnapshot,
): ActivityFeedSnapshot {
  return snapshot.status === "RUNNING"
    ? { ...snapshot, status: "COMPLETED" }
    : snapshot;
}

function choosePreferredTurn(
  existing: ActivityTurnViewModel,
  candidate: ActivityTurnViewModel,
): ActivityTurnViewModel {
  if (candidate.isActiveTurn && candidate.hasVisibleRows) {
    return candidate;
  }
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
