import {
  type ActivityFeedSnapshot,
  RUN_EVENT_TYPES,
  type RunEvent,
  type TurnActivityTranscriptPart,
} from "@repo/shared-types";
import type { RunStatus } from "../types.js";
import { projectRunActivityFeed } from "./RunActivityFeedProjector.js";

interface ProjectRunActivityTranscriptParams {
  runId: string;
  sessionId: string;
  events: RunEvent[];
  terminalStatus: "paused" | "failed" | "cancelled" | "completed";
  terminalReason?: string;
}

export function projectRunActivityTranscript(
  params: ProjectRunActivityTranscriptParams,
): TurnActivityTranscriptPart {
  const orderedEvents = [...params.events].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  const currentTurnId = selectCurrentTurnId(orderedEvents);

  return {
    version: 1,
    type: "turn_activity",
    events: [],
    activitySnapshot: selectCurrentTurnSnapshot(
      projectRunActivityFeed({
        runId: params.runId,
        run: {
          id: params.runId,
          sessionId: params.sessionId,
          status: mapActivitySnapshotRunStatus(params.terminalStatus),
          metadata: { prompt: "" },
        },
        events: orderedEvents,
      }),
      currentTurnId,
    ),
    compacted: false,
  };
}

function selectCurrentTurnId(events: RunEvent[]): string | undefined {
  let turnIndex = 0;
  let currentTurnId: string | undefined;

  for (const event of events) {
    if (
      event.type !== RUN_EVENT_TYPES.MESSAGE_EMITTED ||
      event.payload.role !== "user"
    ) {
      continue;
    }

    turnIndex += 1;
    currentTurnId =
      readClientMessageId(event.payload.metadata) ?? `turn-${turnIndex}`;
  }

  return currentTurnId;
}

function readClientMessageId(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const value = metadata?.clientMessageId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function selectCurrentTurnSnapshot(
  snapshot: ActivityFeedSnapshot,
  currentTurnId: string | undefined,
): ActivityFeedSnapshot {
  if (!currentTurnId) {
    return snapshot;
  }

  return {
    ...snapshot,
    items: snapshot.items.filter((item) => item.turnId === currentTurnId),
  };
}

function mapActivitySnapshotRunStatus(
  status: ProjectRunActivityTranscriptParams["terminalStatus"],
): RunStatus {
  switch (status) {
    case "completed":
      return "COMPLETED";
    case "failed":
      return "FAILED";
    case "cancelled":
      return "CANCELLED";
    case "paused":
      return "PAUSED";
  }
}
