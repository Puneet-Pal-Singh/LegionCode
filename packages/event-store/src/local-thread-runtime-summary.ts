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
    if (admission.userMessage.type !== "user_message") throw corrupt();
    // Delegated selection is immutable ownership evidence. Its adapter keeps its
    // own producer identity; this Native reader never interprets driver details.
    if (hasDelegatedOwnership(admission)) continue;
    let sequence = 0;
    let settled = false;
    let assistantLeaf: ItemId | undefined;
    let activity = admission.userMessage.createdAt;
    for (const row of lifecycle.iterate(admission.turn.id) as Iterable<StoredEvent>) {
      const event = parseLifecycle(row.event_json);
      if (event.threadId !== scope.threadId || event.turnId !== admission.turn.id ||
        event.runAttemptId !== admission.runAttemptId || event.producer.id !== admission.run.workerId ||
        row.thread_id !== scope.threadId ||
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
          start.runAttemptId !== admission.runAttemptId || start.producer.id !== admission.run.workerId ||
          start.sequence !== startRow.sequence ||
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
  // Compare shared insertion order, never independent producer timestamps.
  const terminal = readPlatformTerminal(database, scope);
  if (terminal && terminal.insertionOrder > terminalOrder) summary.lastTerminalTurnId = terminal.turnId;
  return summary;
}

export function hasDelegatedOwnership(admission: TurnAdmission): boolean {
  return ("harnessSelection" in admission.run && admission.run.harnessSelection !== undefined) ||
    (admission.userMessage.type === "user_message" && admission.userMessage.content.harnessSelection !== undefined);
}

/** Synchronous admission precondition, using the same facts as Thread reads.
 * This does not repair/reparent a candidate already frozen for execution. */
export function readLocalThreadParents(
  database: Database.Database,
  scope: LocalThreadRuntimeScope,
  summary: LocalThreadRuntimeSummary | null,
): { parentTurnId: TurnId | null; parentItemId: ItemId | null } {
  const itemQuery = `SELECT * FROM events WHERE family = 'platform' AND thread_id = ?
    AND json_extract(event_json, '$.type') IN ('item.started', 'item.updated', 'item.completed')`;
  const leafRow = database.prepare(`${itemQuery} ORDER BY insertion_order DESC LIMIT 1`)
    .get(scope.threadId) as StoredEvent | undefined;
  const leaf = leafRow ? readPlatformItem(database, scope, leafRow) : null;
  // The existing platform projector retains the latest non-null item Run pointer.
  const runRow = leaf?.runId ? undefined : database.prepare(`${itemQuery}
    AND json_extract(event_json, '$.payload.item.runId') IS NOT NULL
    ORDER BY insertion_order DESC LIMIT 1`).get(scope.threadId) as StoredEvent | undefined;
  const latestRunId = leaf?.runId ?? (runRow ? readPlatformItem(database, scope, runRow).runId : null);
  return {
    parentTurnId: summary?.lastTerminalTurnId ?? readPlatformTerminal(database, scope)?.turnId ?? null,
    parentItemId: summary && summary.latestAdmissionRunId === latestRunId
      ? summary.activeLeafItemId : leaf?.id ?? null,
  };
}

function readPlatformTerminal(database: Database.Database, scope: LocalThreadRuntimeScope) {
  const row = database.prepare(`SELECT * FROM events WHERE family = 'platform'
    AND thread_id = ? AND json_extract(event_json, '$.type') IN ('turn.completed', 'turn.failed')
    ORDER BY insertion_order DESC LIMIT 1`).get(scope.threadId) as StoredEvent | undefined;
  if (!row) return null;
  const event = parsePlatform(row.event_json);
  if ((event.type !== "turn.completed" && event.type !== "turn.failed") ||
    event.threadId !== scope.threadId || event.workspaceId !== scope.workspaceId ||
    row.thread_id !== scope.threadId || row.stream_type !== event.scopeType ||
    row.stream_id !== event.scopeId || row.sequence !== event.sequence) throw corrupt();
  assertPlatformRunOwner(database, scope, event.runId);
  return { turnId: event.payload.turn.id, insertionOrder: row.insertion_order };
}

function readPlatformItem(database: Database.Database, scope: LocalThreadRuntimeScope, row: StoredEvent) {
  const event = parsePlatform(row.event_json);
  if ((event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") ||
    event.threadId !== scope.threadId || event.workspaceId !== scope.workspaceId ||
    row.thread_id !== scope.threadId || row.stream_type !== event.scopeType ||
    row.stream_id !== event.scopeId || row.sequence !== event.sequence) throw corrupt();
  if (event.runId !== null) assertPlatformRunOwner(database, scope, event.runId);
  return event.payload.item;
}

function assertPlatformRunOwner(database: Database.Database, scope: LocalThreadRuntimeScope, runId: RunId | null) {
  const row = database.prepare(`SELECT event_json FROM events WHERE family = 'platform'
    AND stream_type = 'run' AND stream_id = ? AND sequence = 1`).get(runId) as { event_json: string } | undefined;
  if (!row) throw corrupt();
  const event = parsePlatform(row.event_json);
  if (event.type !== "run.created" || event.threadId !== scope.threadId ||
    event.workspaceId !== scope.workspaceId || event.runId !== runId ||
    event.payload.run.userId !== scope.userId) throw corrupt();
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
