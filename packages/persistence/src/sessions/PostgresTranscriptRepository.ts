import type { JsonValue } from "@repo/shared-types";

import type { SqlClient, SqlRow, SqlValue } from "../sql.js";
import type {
  AppendExistingTranscriptMessageInput,
  AppendTranscriptMessageInput,
  EnsureTranscriptSessionInput,
  ListSessionsResult,
  ListTranscriptInput,
  ListTranscriptResult,
  SessionRecord,
  TaskRecord,
  TranscriptMessagePartRecord,
  TranscriptMessagePartType,
  TranscriptMessageRecord,
  TranscriptMessageRole,
  TranscriptRepository,
} from "./types.js";
import { assertHasParts, firstSequence, lastSequence } from "./transcriptUtils.js";

interface Clock {
  now(): Date;
}

interface TranscriptRow extends SqlRow {
  task_id?: string;
  task_user_id?: string;
  task_workspace_id?: string | null;
  task_title?: string;
  task_status?: string;
  task_created_at?: string | Date;
  task_updated_at?: string | Date;
  task_archived_at?: string | Date | null;
  session_id?: string;
  session_user_id?: string;
  session_workspace_id?: string | null;
  session_task_id?: string;
  session_title?: string;
  repository?: string | null;
  active_run_id?: string | null;
  mode?: string;
  session_status?: string;
  session_created_at?: string | Date;
  session_updated_at?: string | Date;
  message_id?: string;
  run_id?: string | null;
  role?: string;
  client_message_id?: string | null;
  message_created_at?: string | Date;
  part_id?: string;
  part_type?: string;
  session_sequence?: number | string;
  content_json?: JsonValue | string;
  part_created_at?: string | Date;
  last_sequence?: number | string;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class PostgresTranscriptRepository implements TranscriptRepository {
  constructor(
    private readonly client: SqlClient,
    private readonly clock: Clock = systemClock,
    private readonly skipTxWrap = false,
  ) {}

  async ensureSession(
    input: EnsureTranscriptSessionInput,
  ): Promise<SessionRecord> {
    if (this.skipTxWrap) {
      return await ensureSessionWithClient(this.client, input, this.clock.now());
    }
    return await this.client.transaction(async (tx) =>
      ensureSessionWithClient(tx, input, this.clock.now()),
    );
  }

  async appendMessage(
    input: AppendTranscriptMessageInput,
  ): Promise<TranscriptMessageRecord> {
    if (this.skipTxWrap) {
      await ensureSessionWithClient(this.client, input, this.clock.now());
      return await appendMessageWithClient(this.client, input, this.clock.now());
    }
    return await this.client.transaction(async (tx) => {
      await ensureSessionWithClient(tx, input, this.clock.now());
      return await appendMessageWithClient(tx, input, this.clock.now());
    });
  }

  async archiveSession(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.client.query<TranscriptRow>(ARCHIVE_SESSION_SQL, [
      userId,
      sessionId,
      this.clock.now(),
    ]);
    return Boolean(result.rows[0]);
  }

  async appendMessageToExistingSession(
    input: AppendExistingTranscriptMessageInput,
  ): Promise<TranscriptMessageRecord> {
    if (this.skipTxWrap) {
      await assertSessionExists(this.client, input.sessionId);
      return await appendMessageWithClient(this.client, input, this.clock.now());
    }
    return await this.client.transaction(async (tx) => {
      await assertSessionExists(tx, input.sessionId);
      return await appendMessageWithClient(tx, input, this.clock.now());
    });
  }

  async listTranscript(
    input: ListTranscriptInput,
  ): Promise<ListTranscriptResult> {
    const result = await this.client.query<TranscriptRow>(LIST_TRANSCRIPT_SQL, [
      input.sessionId,
      input.runId ?? null,
      input.cursor ?? 0,
      input.limit ?? 100,
      input.userId ?? null,
    ]);
    const messages = groupMessages(result.rows);
    const lastMessage = messages[messages.length - 1];

    return {
      messages,
      nextCursor:
        messages.length >= (input.limit ?? 100) && lastMessage
          ? lastSequence(lastMessage)
          : null,
    };
  }

  async listSessions(userId: string): Promise<ListSessionsResult> {
    const result = await this.client.query<TranscriptRow>(LIST_SESSIONS_SQL, [
      userId,
    ]);

    return {
      tasks: mapUniqueTasks(result.rows),
      sessions: result.rows
        .filter((row) => row.session_id)
        .map((row) => mapSessionRow(row)),
    };
  }

  async transaction<T>(
    callback: (repository: TranscriptRepository) => Promise<T>,
  ): Promise<T> {
    return await this.client.transaction(async (tx) => {
      return await callback(new PostgresTranscriptRepository(tx, this.clock, true));
    });
  }
}

async function ensureSessionWithClient(
  client: SqlClient,
  input: EnsureTranscriptSessionInput,
  now: Date,
): Promise<SessionRecord> {
  const task = await upsertTask(client, input, now);
  const result = await client.query<TranscriptRow>(UPSERT_SESSION_SQL, [
    input.sessionId,
    input.userId,
    input.workspaceId ?? null,
    task.id,
    input.title ?? task.title,
    input.repository ?? null,
    input.activeRunId ?? null,
    input.mode ?? "build",
    input.status ?? "idle",
    now,
  ]);

  return mapSessionRow(readReturnedRow(result.rows[0], "sessions"));
}

async function upsertTask(
  client: SqlClient,
  input: EnsureTranscriptSessionInput,
  now: Date,
): Promise<TaskRecord> {
  const result = await client.query<TranscriptRow>(UPSERT_TASK_SQL, [
    input.taskId ?? input.sessionId,
    input.userId,
    input.workspaceId ?? null,
    input.title ?? "Untitled task",
    now,
  ]);

  return mapTaskRow(readReturnedRow(result.rows[0], "tasks"));
}

async function assertSessionExists(
  client: SqlClient,
  sessionId: string,
): Promise<void> {
  const result = await client.query<TranscriptRow>(FIND_SESSION_SQL, [
    sessionId,
  ]);
  if (!result.rows[0]) {
    throw new Error(`Transcript session not found: ${sessionId}`);
  }
}

async function appendMessageWithClient(
  client: SqlClient,
  input: AppendExistingTranscriptMessageInput,
  now: Date,
): Promise<TranscriptMessageRecord> {
  assertHasParts(input.parts);
  const inserted = await insertMessage(client, input, now);
  if (!inserted) {
    return await readMessageByDedupeKey(client, input.sessionId, input.dedupeKey);
  }

  const lastSequence = await incrementSessionSequence(
    client,
    input.sessionId,
    input.parts.length,
    now,
  );
  const startSequence = lastSequence - input.parts.length + 1;
  const parts = await insertMessageParts(
    client,
    input,
    inserted.id,
    startSequence,
    now,
  );

  return { ...inserted, parts };
}

async function insertMessage(
  client: SqlClient,
  input: AppendExistingTranscriptMessageInput,
  now: Date,
): Promise<TranscriptMessageRecord | null> {
  const result = await client.query<TranscriptRow>(INSERT_MESSAGE_SQL, [
    input.sessionId,
    input.runId ?? null,
    input.role,
    input.clientMessageId ?? null,
    input.dedupeKey,
    now,
  ]);
  const row = result.rows[0];
  return row ? { ...mapMessageRow(row), parts: [] } : null;
}

async function readMessageByDedupeKey(
  client: SqlClient,
  sessionId: string,
  dedupeKey: string,
): Promise<TranscriptMessageRecord> {
  const result = await client.query<TranscriptRow>(FIND_MESSAGE_BY_DEDUPE_SQL, [
    sessionId,
    dedupeKey,
  ]);
  const messages = groupMessages(result.rows);
  const message = messages[0];
  if (!message) {
    throw new Error(`Transcript message not found for dedupe key: ${dedupeKey}`);
  }
  return message;
}

async function incrementSessionSequence(
  client: SqlClient,
  sessionId: string,
  increment: number,
  now: Date,
): Promise<number> {
  const result = await client.query<TranscriptRow>(INCREMENT_SESSION_SEQUENCE_SQL, [
    sessionId,
    increment,
    now,
  ]);
  return toNumber(readReturnedRow(result.rows[0], "sessions").last_sequence);
}

async function insertMessageParts(
  client: SqlClient,
  input: AppendExistingTranscriptMessageInput,
  messageId: string,
  startSequence: number,
  now: Date,
): Promise<TranscriptMessagePartRecord[]> {
  const values: SqlValue[] = [];
  const placeholders: string[] = [];
  let paramIdx = 1;

  for (let i = 0; i < input.parts.length; i++) {
    const part = input.parts[i]!;
    const sequence = startSequence + i;
    values.push(
      input.sessionId,
      messageId,
      input.runId ?? null,
      part.type,
      sequence,
      JSON.stringify(part.content),
      now,
    );
    placeholders.push(
      `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::jsonb, $${paramIdx++})`,
    );
  }

  const sql = `
    INSERT INTO message_parts (
      session_id,
      message_id,
      run_id,
      part_type,
      session_sequence,
      content_json,
      created_at
    )
    VALUES ${placeholders.join(", ")}
    RETURNING
      id AS part_id,
      session_id,
      message_id,
      run_id,
      part_type,
      session_sequence,
      content_json,
      created_at AS part_created_at
  `;

  const result = await client.query<TranscriptRow>(sql, values);
  return result.rows.map((row) => mapMessagePartRow(row));
}

function mapUniqueTasks(rows: TranscriptRow[]): TaskRecord[] {
  const tasks = new Map<string, TaskRecord>();
  for (const row of rows) {
    const task = mapTaskRow(row);
    tasks.set(task.id, task);
  }
  return Array.from(tasks.values());
}

function groupMessages(rows: TranscriptRow[]): TranscriptMessageRecord[] {
  const messages = new Map<string, TranscriptMessageRecord>();
  for (const row of rows) {
    const messageId = requireString(row.message_id, "message_id");
    const existing = messages.get(messageId) ?? {
      ...mapMessageRow(row),
      parts: [],
    };
    existing.parts.push(mapMessagePartRow(row));
    messages.set(messageId, existing);
  }
  return Array.from(messages.values()).sort(
    (left, right) => firstSequence(left) - firstSequence(right),
  );
}

function mapTaskRow(row: TranscriptRow): TaskRecord {
  return {
    id: requireString(row.task_id, "task_id"),
    userId: requireString(row.task_user_id, "task_user_id"),
    workspaceId: row.task_workspace_id ?? null,
    title: requireString(row.task_title, "task_title"),
    status: mapTaskStatus(requireString(row.task_status, "task_status")),
    createdAt: toIsoString(row.task_created_at),
    updatedAt: toIsoString(row.task_updated_at),
    archivedAt: row.task_archived_at ? toIsoString(row.task_archived_at) : null,
  };
}

function mapSessionRow(row: TranscriptRow): SessionRecord {
  return {
    id: requireString(row.session_id, "session_id"),
    userId: requireString(row.session_user_id, "session_user_id"),
    workspaceId: row.session_workspace_id ?? null,
    taskId: requireString(row.session_task_id, "session_task_id"),
    title: requireString(row.session_title, "session_title"),
    repository: row.repository ?? null,
    activeRunId: row.active_run_id ?? null,
    mode: requireString(row.mode, "mode"),
    status: mapSessionStatus(requireString(row.session_status, "session_status")),
    createdAt: toIsoString(row.session_created_at),
    updatedAt: toIsoString(row.session_updated_at),
  };
}

function mapMessageRow(row: TranscriptRow): Omit<TranscriptMessageRecord, "parts"> {
  return {
    id: requireString(row.message_id, "message_id"),
    sessionId: requireString(row.session_id, "session_id"),
    runId: row.run_id ?? null,
    role: mapMessageRole(requireString(row.role, "role")),
    clientMessageId: row.client_message_id ?? null,
    createdAt: toIsoString(row.message_created_at),
  };
}

function mapMessagePartRow(row: TranscriptRow): TranscriptMessagePartRecord {
  return {
    id: requireString(row.part_id, "part_id"),
    messageId: requireString(row.message_id, "message_id"),
    sessionId: requireString(row.session_id, "session_id"),
    runId: row.run_id ?? null,
    type: mapPartType(requireString(row.part_type, "part_type")),
    sessionSequence: toNumber(row.session_sequence),
    content: parseContentJson(row.content_json, row.part_id),
    createdAt: toIsoString(row.part_created_at),
  };
}

function mapTaskStatus(status: string): TaskRecord["status"] {
  if (status === "active" || status === "archived") {
    return status;
  }
  throw new Error(`Unsupported task status: ${status}`);
}

function mapSessionStatus(status: string): SessionRecord["status"] {
  if (
    status === "idle" ||
    status === "running" ||
    status === "completed" ||
    status === "failed"
  ) {
    return status;
  }
  throw new Error(`Unsupported session status: ${status}`);
}

function mapMessageRole(role: string): TranscriptMessageRole {
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
    return role;
  }
  throw new Error(`Unsupported transcript message role: ${role}`);
}

function mapPartType(type: string): TranscriptMessagePartType {
  if (
    type === "text" ||
    type === "tool_call" ||
    type === "tool_result" ||
    type === "activity" ||
    type === "compaction_summary" ||
    type === "raw"
  ) {
    return type;
  }
  throw new Error(`Unsupported transcript message part type: ${type}`);
}

function parseContentJson(value: JsonValue | string | undefined, partId: unknown): JsonValue {
  if (typeof value !== "string") {
    return value ?? null;
  }

  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(`Invalid content_json for message_part ${String(partId)}`, {
      cause: error,
    });
  }
}

function readReturnedRow(
  row: TranscriptRow | undefined,
  tableName: string,
): TranscriptRow {
  if (!row) {
    throw new Error(`${tableName} statement returned no row`);
  }
  return row;
}

function requireString(value: unknown, columnName: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Expected ${columnName} to be a string`);
}

function toIsoString(value: string | Date | undefined): string {
  if (!value) {
    throw new Error("Missing timestamp column");
  }
  return value instanceof Date ? value.toISOString() : value;
}

function toNumber(value: number | string | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  throw new Error("Missing numeric column");
}

const TASK_COLUMNS = `
  id AS task_id,
  user_id AS task_user_id,
  workspace_id AS task_workspace_id,
  title AS task_title,
  status AS task_status,
  created_at AS task_created_at,
  updated_at AS task_updated_at,
  archived_at AS task_archived_at
`;

const JOINED_TASK_COLUMNS = `
  tasks.id AS task_id,
  tasks.user_id AS task_user_id,
  tasks.workspace_id AS task_workspace_id,
  tasks.title AS task_title,
  tasks.status AS task_status,
  tasks.created_at AS task_created_at,
  tasks.updated_at AS task_updated_at,
  tasks.archived_at AS task_archived_at
`;

const SESSION_COLUMNS = `
  id AS session_id,
  user_id AS session_user_id,
  workspace_id AS session_workspace_id,
  task_id AS session_task_id,
  title AS session_title,
  repository,
  active_run_id,
  mode,
  status AS session_status,
  created_at AS session_created_at,
  updated_at AS session_updated_at
`;

const MESSAGE_COLUMNS = `
  m.id AS message_id,
  m.session_id,
  m.run_id,
  m.role,
  m.client_message_id,
  m.created_at AS message_created_at
`;

const PART_COLUMNS = `
  p.id AS part_id,
  p.part_type,
  p.session_sequence,
  p.content_json,
  p.created_at AS part_created_at
`;

const UPSERT_TASK_SQL = `
  INSERT INTO tasks (id, user_id, workspace_id, title, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $5)
  ON CONFLICT (id)
  DO UPDATE SET
    workspace_id = EXCLUDED.workspace_id,
    title = EXCLUDED.title,
    updated_at = EXCLUDED.updated_at
  WHERE tasks.user_id = EXCLUDED.user_id
  RETURNING ${TASK_COLUMNS}
`;

const UPSERT_SESSION_SQL = `
  INSERT INTO sessions (
    id,
    user_id,
    workspace_id,
    task_id,
    title,
    repository,
    active_run_id,
    mode,
    status,
    created_at,
    updated_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
  ON CONFLICT (id)
  DO UPDATE SET
    workspace_id = EXCLUDED.workspace_id,
    task_id = EXCLUDED.task_id,
    title = EXCLUDED.title,
    repository = COALESCE(EXCLUDED.repository, sessions.repository),
    active_run_id = COALESCE(EXCLUDED.active_run_id, sessions.active_run_id),
    mode = EXCLUDED.mode,
    status = EXCLUDED.status,
    updated_at = EXCLUDED.updated_at
  WHERE sessions.user_id = EXCLUDED.user_id
  RETURNING ${SESSION_COLUMNS}
`;

const FIND_SESSION_SQL = `
  SELECT ${SESSION_COLUMNS}
  FROM sessions
  WHERE id = $1
`;

const ARCHIVE_SESSION_SQL = `
  WITH archived_task AS (
    UPDATE tasks
    SET
      status = 'archived',
      archived_at = $3,
      updated_at = $3
    FROM sessions
    WHERE sessions.id = $2
      AND sessions.user_id = $1
      AND sessions.task_id = tasks.id
      AND tasks.user_id = $1
      AND tasks.archived_at IS NULL
    RETURNING tasks.id
  )
  UPDATE sessions
  SET updated_at = $3
  WHERE id = $2
    AND user_id = $1
    AND task_id IN (SELECT id FROM archived_task)
  RETURNING id AS session_id
`;

const INSERT_MESSAGE_SQL = `
  INSERT INTO messages (
    session_id,
    run_id,
    role,
    client_message_id,
    dedupe_key,
    created_at
  )
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (session_id, dedupe_key) DO NOTHING
  RETURNING
    id AS message_id,
    session_id,
    run_id,
    role,
    client_message_id,
    created_at AS message_created_at
`;

const FIND_MESSAGE_BY_DEDUPE_SQL = `
  SELECT ${MESSAGE_COLUMNS}, ${PART_COLUMNS}
  FROM messages m
  JOIN message_parts p ON p.message_id = m.id
  WHERE m.session_id = $1 AND m.dedupe_key = $2
  ORDER BY p.session_sequence ASC
`;

const INCREMENT_SESSION_SEQUENCE_SQL = `
  UPDATE sessions
  SET last_sequence = last_sequence + $2,
      updated_at = $3
  WHERE id = $1
  RETURNING last_sequence
`;

const LIST_TRANSCRIPT_SQL = `
  SELECT ${MESSAGE_COLUMNS}, ${PART_COLUMNS}
  FROM messages m
  JOIN message_parts p ON p.message_id = m.id
  JOIN sessions s ON s.id = p.session_id
  WHERE m.id IN (
    SELECT m2.id
    FROM messages m2
    JOIN message_parts p2 ON p2.message_id = m2.id
    WHERE p2.session_id = $1
      AND ($2::uuid IS NULL OR p2.run_id = $2 OR m2.run_id = $2)
      AND p2.session_sequence > $3
    GROUP BY m2.id
    ORDER BY MIN(p2.session_sequence) ASC
    LIMIT $4
  )
    AND ($5::uuid IS NULL OR s.user_id = $5)
  ORDER BY p.session_sequence ASC
`;

const LIST_SESSIONS_SQL = `
  SELECT
    ${JOINED_TASK_COLUMNS},
    s.id AS session_id,
    s.user_id AS session_user_id,
    s.workspace_id AS session_workspace_id,
    s.task_id AS session_task_id,
    s.title AS session_title,
    s.repository,
    s.active_run_id,
    s.mode,
    s.status AS session_status,
    s.created_at AS session_created_at,
    s.updated_at AS session_updated_at
  FROM tasks
  LEFT JOIN sessions s ON s.task_id = tasks.id
  WHERE tasks.user_id = $1
    AND tasks.archived_at IS NULL
  ORDER BY tasks.updated_at DESC, s.updated_at DESC
`;
