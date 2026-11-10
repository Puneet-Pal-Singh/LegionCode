import type Database from "better-sqlite3";
import {
  LifecycleEventSchema,
  PlatformEventSchema,
  type ItemId,
  type RunId,
  type ThreadId,
  type TurnAdmission,
  type TurnId,
  type UserId,
  type WorkspaceId,
} from "@repo/platform-protocol";
import { LocalPersistenceError } from "./errors.js";

export type LocalThreadRuntimeScope = {
  threadId: ThreadId;
  userId: UserId;
  workspaceId: WorkspaceId;
};
export type LocalThreadRuntimeSummary = {
  latestAdmissionRunId: RunId;
  activeLeafItemId: ItemId;
  lastTerminalTurnId: TurnId | null;
  updatedAt: string;
};
type StoredEvent = {
  event_json: string;
  insertion_order: number;
  thread_id: string;
  turn_id: string | null;
  sequence: number;
  stream_id: string;
  stream_type: string;
};

/** Read facts only. Admission and lifecycle writers remain the canonical owners.
 * One admission/event at a time; item identity lookup retains no transcript map. */
export function readLocalThreadRuntimeSummary(
  database: Database.Database,
  scope: LocalThreadRuntimeScope,
  admissions: Iterable<TurnAdmission>,
): LocalThreadRuntimeSummary | null {
  let summary: LocalThreadRuntimeSummary | null = null;
  let terminalOrder = 0;
  let lastTerminalTurnId: TurnId | null = null;
  const lifecycle = database.prepare(`SELECT * FROM events
    WHERE family = 'lifecycle' AND turn_id = ? ORDER BY sequence`);
  const startForItem = database.prepare(`SELECT * FROM events
    WHERE family = 'lifecycle' AND turn_id = ? AND sequence < ?
      AND json_extract(event_json, '$.type') = 'item.started'
      AND json_extract(event_json, '$.itemId') = ? ORDER BY sequence DESC LIMIT 1`);
  for (const admission of admissions) {
    if (admission.run.threadId !== scope.threadId || admission.run.userId !== scope.userId ||
      admission.run.workspaceId !== scope.workspaceId) throw corrupt();
    let sequence = 0;
    let settled = false;
    let assistantLeaf: ItemId | undefined;
    let activity = admission.userMessage.createdAt;
    for (const row of lifecycle.iterate(admission.turn.id) as Iterable<StoredEvent>) {
      const event = parseLifecycle(row.event_json);
      if (event.threadId !== scope.threadId || event.turnId !== admission.turn.id ||
        event.runAttemptId !== admission.runAttemptId || row.thread_id !== scope.threadId ||
        row.turn_id !== admission.turn.id || row.stream_type !== "turn" ||
        row.stream_id !== admission.turn.id || event.sequence !== ++sequence ||
        row.sequence !== event.sequence || settled) throw corrupt();
      activity = laterTimestamp(activity, event.createdAt);
      if (event.type === "item.completed") {
        const startRow = startForItem.get(admission.turn.id, event.sequence, event.itemId) as StoredEvent | undefined;
        if (!startRow) throw corrupt();
        const start = parseLifecycle(startRow.event_json);
        if (start.type !== "item.started" || start.itemId !== event.itemId ||
          start.threadId !== scope.threadId || start.turnId !== admission.turn.id ||
          start.runAttemptId !== admission.runAttemptId || start.sequence !== startRow.sequence ||
          startRow.thread_id !== scope.threadId || startRow.turn_id !== admission.turn.id ||
          startRow.stream_type !== "turn" || startRow.stream_id !== admission.turn.id) throw corrupt();
        if (start.payload.kind === "assistant_message") assistantLeaf = event.itemId;
      }
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted") {
        settled = true;
        if (row.insertion_order > terminalOrder) {
          terminalOrder = row.insertion_order;
          lastTerminalTurnId = event.turnId;
        }
      }
    }
    summary = {
      latestAdmissionRunId: admission.run.id,
      activeLeafItemId: settled && assistantLeaf ? assistantLeaf : admission.userMessage.id,
      lastTerminalTurnId,
      updatedAt: summary ? laterTimestamp(summary.updatedAt, activity) : activity,
    };
  }
  if (!summary) return null;
  // A later external runtime can already have a platform terminal. Compare the
  // shared event insertion order, never timestamps from independent producers.
  const platformRow = database.prepare(`SELECT * FROM events WHERE family = 'platform'
    AND thread_id = ? AND json_extract(event_json, '$.type') IN ('turn.completed', 'turn.failed')
    ORDER BY insertion_order DESC LIMIT 1`).get(scope.threadId) as StoredEvent | undefined;
  if (platformRow) {
    const event = parsePlatform(platformRow.event_json);
    if ((event.type !== "turn.completed" && event.type !== "turn.failed") ||
      event.threadId !== scope.threadId || event.workspaceId !== scope.workspaceId ||
      platformRow.thread_id !== scope.threadId || platformRow.stream_type !== event.scopeType ||
      platformRow.stream_id !== event.scopeId || platformRow.sequence !== event.sequence) throw corrupt();
    const runRow = database.prepare(`SELECT event_json FROM events WHERE family = 'platform'
      AND stream_type = 'run' AND stream_id = ? AND sequence = 1`).get(event.runId) as { event_json: string } | undefined;
    if (!runRow) throw corrupt();
    const run = parsePlatform(runRow.event_json);
    if (run.type !== "run.created" || run.threadId !== scope.threadId ||
      run.workspaceId !== scope.workspaceId || run.runId !== event.runId ||
      run.payload.run.userId !== scope.userId) throw corrupt();
    if (platformRow.insertion_order > terminalOrder) summary.lastTerminalTurnId = event.payload.turn.id;
  }
  return summary;
}

function parseLifecycle(value: string) {
  try { return LifecycleEventSchema.parse(JSON.parse(value)); }
  catch { throw corrupt(); }
}
function parsePlatform(value: string) {
  try { return PlatformEventSchema.parse(JSON.parse(value)); }
  catch { throw corrupt(); }
}
function laterTimestamp(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}
function corrupt(): LocalPersistenceError {
  return new LocalPersistenceError("corrupt", "Local Thread runtime summary does not match canonical history");
}
