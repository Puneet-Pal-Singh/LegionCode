import type Database from "better-sqlite3";
import { PlatformEventSchema, ThreadIdSchema, UserIdSchema, WorkspaceIdSchema, type Thread } from "@repo/platform-protocol";
import { EventStoreError, LocalPersistenceError } from "./errors.js";

/** Shared canonical Thread ownership read under the original SQLite transaction. */
export function readLocalOwnedThread(database: Database.Database, input: {
  readonly threadId: string; readonly userId: string; readonly workspaceId: string;
}, requireActive = true): Thread {
  const scope = { threadId: ThreadIdSchema.parse(input.threadId), userId: UserIdSchema.parse(input.userId), workspaceId: WorkspaceIdSchema.parse(input.workspaceId) };
  // Read the canonical Thread stream under the same writer transaction as admission.
  // Its latest full Thread record is authoritative; no admission-owned status is stored.
  const rows = database.prepare(`SELECT event_json FROM events
    WHERE family = 'platform' AND stream_type = 'thread' AND stream_id = ? ORDER BY sequence`)
    .iterate(scope.threadId) as Iterable<{ event_json: string }>;
  let thread: Thread | null = null;
  let index = -1;
  for (const row of rows) {
    index += 1;
    const event = PlatformEventSchema.parse(JSON.parse(row.event_json));
    if (event.threadId !== scope.threadId || event.scopeType !== "thread" || event.scopeId !== scope.threadId
      || event.sequence !== index + 1 || (index === 0 && event.type !== "thread.created")
      || (index > 0 && event.type === "thread.created") || (thread && event.workspaceId !== thread.workspaceId)) {
      throw invalidThread("Admission Thread stream identity is inconsistent");
    }
    if (event.type === "thread.title.updated") continue;
    if (event.type !== "thread.created" && event.type !== "thread.pinned" && event.type !== "thread.unpinned"
      && event.type !== "thread.archived" && event.type !== "thread.unarchived") {
      throw invalidThread("Admission Thread stream contains a non-Thread record");
    }
    const record = event.payload.thread;
    if (record.id !== scope.threadId || event.workspaceId !== record.workspaceId
      || (thread && (record.workspaceId !== thread.workspaceId || record.userId !== thread.userId))) {
      throw invalidThread("Canonical Thread ownership changed within its stream");
    }
    thread = record;
  }
  if (!thread || (requireActive && thread.status !== "active") || thread.id !== scope.threadId
    || thread.workspaceId !== scope.workspaceId || thread.userId !== scope.userId) {
    throw new EventStoreError("idempotency_conflict", "New admission requires an active canonical Thread with matching owner and workspace");
  }
  return thread;
}
function invalidThread(message: string): LocalPersistenceError {
  return new LocalPersistenceError("corrupt", message);
}
