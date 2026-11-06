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
  return session.archivedAt ?? (task?.userId === session.userId ? task.archivedAt : null);
}

/** Prepare a single-session restore inside the caller's existing transaction. */
export async function prepareOwnedSessionUnarchive(
  client: SqlClient,
  userId: string,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  const result = await client.query<ArchiveTargetRow>(`
    SELECT s.task_id, tasks.archived_at AS inherited_archived_at
    FROM sessions s JOIN tasks ON tasks.id = s.task_id
    WHERE s.user_id = $1 AND s.id = $2 AND tasks.user_id = $1
      AND COALESCE(s.archived_at, tasks.archived_at) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sessions sibling
        WHERE sibling.task_id = tasks.id AND sibling.user_id <> $1
      )
    FOR UPDATE OF tasks
  `, [userId, sessionId]);
  const target = result.rows[0];
  if (!target) return false;
  // All restores lock the parent first, then the target, before touching siblings.
  const locked = await client.query(`
    SELECT id FROM sessions
    WHERE user_id = $1 AND id = $2 AND task_id = $3
      AND (archived_at IS NOT NULL OR $4::timestamptz IS NOT NULL)
    FOR UPDATE
  `, [userId, sessionId, target.task_id, target.inherited_archived_at]);
  if (locked.rows.length === 0) return false;
  if (target.inherited_archived_at !== null) {
    // Clearing a shared parent must not restore its other conversations.
    await client.query(`
      UPDATE sessions SET archived_at = $4
      WHERE user_id = $1 AND task_id = $3 AND id <> $2
        AND archived_at IS NULL
    `, [userId, sessionId, target.task_id, target.inherited_archived_at]);
    await client.query(`
      UPDATE tasks SET archived_at = NULL, status = 'active', updated_at = $3
      WHERE user_id = $1 AND id = $2
    `, [userId, target.task_id, now]);
  }
  return true;
}
