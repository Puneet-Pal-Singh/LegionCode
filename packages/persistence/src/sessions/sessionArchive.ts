import type { SqlClient, SqlRow } from "../sql.js";
import type { SessionRecord, TaskRecord } from "./types.js";

interface ArchiveTargetRow extends SqlRow {
  task_id: string;
  inherited_archived_at: string | Date | null;
}

/** Historical task archives remain effective until an explicit session restore. */
export function effectiveSessionArchive(
  session: SessionRecord,
  task: TaskRecord | undefined,
): string | null {
  return (
    session.archivedAt ??
    (task?.userId === session.userId ? task.archivedAt : null)
  );
}

/** Caller must hold a transaction; lock the parent before a fresh archive read. */
export async function lockOwnedArchivedSession(
  client: SqlClient,
  userId: string,
  sessionId: string,
): Promise<ArchiveTargetRow | null> {
  const parent = await client.query<SqlRow & { task_id: string }>(
    `
    SELECT tasks.id AS task_id
    FROM tasks JOIN sessions s ON s.task_id = tasks.id
    WHERE tasks.user_id = $1 AND s.user_id = $1 AND s.id = $2
    FOR UPDATE OF tasks
  `,
    [userId, sessionId],
  );
  const taskId = parent.rows[0]?.task_id;
  if (!taskId) return null;
  // Under READ COMMITTED a lock wait does not refresh the statement's snapshot
  // of the other joined table. Read both archive timestamps only after that wait.
  const result = await client.query<ArchiveTargetRow>(
    `
    SELECT s.task_id, tasks.archived_at AS inherited_archived_at
    FROM sessions s JOIN tasks ON tasks.id = s.task_id
    WHERE s.user_id = $1 AND s.id = $2 AND tasks.user_id = $1
      AND s.task_id = $3
      AND COALESCE(s.archived_at, tasks.archived_at) IS NOT NULL
    FOR UPDATE OF s
  `,
    [userId, sessionId, taskId],
  );
  return result.rows[0] ?? null;
}

/** Prepare a single-session restore inside the caller's existing transaction. */
export async function prepareOwnedSessionUnarchive(
  client: SqlClient,
  userId: string,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  const target = await lockOwnedArchivedSession(client, userId, sessionId);
  if (!target) return false;
  const foreignSiblings = await client.query(
    `
    SELECT id FROM sessions WHERE task_id = $1 AND user_id <> $2
  `,
    [target.task_id, userId],
  );
  if (foreignSiblings.rows.length > 0) return false;
  if (target.inherited_archived_at !== null) {
    // Clearing a shared parent must not restore its other conversations.
    await client.query(
      `
      UPDATE sessions SET archived_at = $4
      WHERE user_id = $1 AND task_id = $3 AND id <> $2
        AND archived_at IS NULL
    `,
      [userId, sessionId, target.task_id, target.inherited_archived_at],
    );
    await client.query(
      `
      UPDATE tasks SET archived_at = NULL, status = 'active', updated_at = $3
      WHERE user_id = $1 AND id = $2
    `,
      [userId, target.task_id, now],
    );
  }
  return true;
}
