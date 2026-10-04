import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresTranscriptRepository } from "./PostgresTranscriptRepository.js";

const NOW = new Date("2026-05-23T00:00:00.000Z");

class CapturingSqlClient implements SqlClient {
  public readonly queries: Array<{
    statement: string;
    params: readonly SqlValue[];
  }> = [];

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.queries.push({ statement, params });

    if (statement.includes("INSERT INTO tasks")) {
      return createResult<Row>(createTaskRow(params));
    }

    if (statement.includes("INSERT INTO sessions")) {
      return createResult<Row>(createSessionRow(params));
    }

    if (statement.includes("DELETE FROM sessions")) {
      return createResult<Row>({ task_id: "task-1" });
    }

    if (statement.includes("SELECT last_sequence") && statement.includes("FROM sessions")) {
      return createResult<Row>({ last_sequence: 10 });
    }

    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }
}

describe("PostgresTranscriptRepository", () => {
  it("preserves omitted metadata and treats null as an explicit clear", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresTranscriptRepository(client, {
      now: () => NOW,
    });

    await repository.ensureSession({
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      userId: "123e4567-e89b-42d3-a456-426614174001",
      workspaceId: "123e4567-e89b-42d3-a456-426614174002",
      title: "Original title",
      repository: "acme/legioncode",
      activeRunId: "123e4567-e89b-42d3-a456-426614174003",
    });

    client.queries.length = 0;
    await repository.ensureSession({
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      userId: "123e4567-e89b-42d3-a456-426614174001",
    });

    expect(client.queries[0]?.params.slice(5, 7)).toEqual([false, false]);
    expect(client.queries[1]?.params.slice(12, 17)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);

    client.queries.length = 0;
    await repository.ensureSession({
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      userId: "123e4567-e89b-42d3-a456-426614174001",
      workspaceId: null,
      repository: null,
      activeRunId: null,
    });

    expect(client.queries[0]?.params.slice(5, 7)).toEqual([true, false]);
    expect(client.queries[1]?.params.slice(12, 17)).toEqual([
      true,
      false,
      false,
      true,
      true,
    ]);
  });

  it("uses session-level archive metadata", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresTranscriptRepository(client, {
      now: () => NOW,
    });

    await repository.archiveSession(
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174000",
    );

    const statement = client.queries[0]?.statement ?? "";
    expect(statement).toContain("SET archived_at = $3");
    expect(statement).toContain("pinned_at = NULL");
    expect(statement).not.toContain("UPDATE tasks");
  });

  it("permanently deletes only archived user sessions and cleans orphan tasks", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresTranscriptRepository(client);

    await expect(
      repository.deleteArchivedSession(
        "123e4567-e89b-42d3-a456-426614174001",
        "123e4567-e89b-42d3-a456-426614174000",
      ),
    ).resolves.toBe(true);

    expect(client.queries[0]?.statement).toContain("archived_at IS NOT NULL");
    expect(client.queries[0]?.params).toEqual([
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174000",
    ]);
    expect(client.queries[1]?.statement).toContain("NOT EXISTS");
    expect(client.queries[1]?.params).toEqual([
      "123e4567-e89b-42d3-a456-426614174001",
      "task-1",
    ]);
  });

  it("keeps session upserts from overwriting titles", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresTranscriptRepository(client, {
      now: () => NOW,
    });

    await repository.ensureSession({
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      userId: "123e4567-e89b-42d3-a456-426614174001",
      title: "Generated",
      titleSource: "generated",
    });

    const statement = client.queries[1]?.statement ?? "";
    expect(statement).not.toContain("title = EXCLUDED.title");
    expect(statement).not.toContain("title_source = EXCLUDED.title_source");
    expect(client.queries[1]?.params).toHaveLength(17);
  });

  it("persists session status updates", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresTranscriptRepository(client, {
      now: () => NOW,
    });

    await repository.updateSessionStatus({
      userId: "123e4567-e89b-42d3-a456-426614174001",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      status: "completed",
    });

    expect(client.queries[0]?.statement).toContain("SET status = $3");
    expect(client.queries[0]?.params[2]).toBe("completed");
  });

  it("keeps transcript list filters on the outer message part join", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresTranscriptRepository(client, {
      now: () => NOW,
    });

    await repository.listTranscript({
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      runId: "run_123e4567e89b42d3a456426614174001",
      userId: "123e4567-e89b-42d3-a456-426614174002",
    });

    const statement = client.queries.find((query) =>
      query.statement.includes("JOIN sessions s2 ON s2.id = p2.session_id"),
    )?.statement ?? "";
    expect(statement).toContain("JOIN sessions s2 ON s2.id = p2.session_id");
    expect(statement).toContain("AND p.session_id = $1");
    expect(statement).toContain(
      "AND ($2::text IS NULL OR p.run_id = $2 OR m.run_id = $2)",
    );
    expect(statement).toContain("AND ($6::uuid IS NULL OR s2.user_id = $6)");
  });

  it("includes canonical title metadata in session list projections", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresTranscriptRepository(client, {
      now: () => NOW,
    });

    await repository.listSessions("123e4567-e89b-42d3-a456-426614174001");
    await repository.listArchivedSessions(
      "123e4567-e89b-42d3-a456-426614174001",
    );

    expect(client.queries[0]?.statement).toContain(
      "s.thread_id AS session_thread_id",
    );
    expect(client.queries[0]?.statement).toContain("s.title_version");
    expect(client.queries[0]?.statement).toContain("s.title_status");
    expect(client.queries[1]?.statement).toContain(
      "s.thread_id AS session_thread_id",
    );
    expect(client.queries[1]?.statement).toContain("s.title_version");
    expect(client.queries[1]?.statement).toContain("s.title_status");
  });

  it("projects approval only from the latest blocking event in the active run's current thread turn", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresTranscriptRepository(client, {
      now: () => NOW,
    });

    await repository.listSessions("123e4567-e89b-42d3-a456-426614174001");

    const statement = client.queries[0]?.statement ?? "";
    expect(statement).toContain("started.thread_id = s.thread_id");
    expect(statement).toContain("started.event_type = 'turn.started'");
    expect(statement).toContain("s.active_run_id IS NOT NULL");
    expect(statement).toContain("left(");
    expect(statement).toContain(
      "'trn_' || substring(s.active_run_id from 5) || '__turn__'",
    );
    expect(statement).toContain("ORDER BY started.append_order DESC");
    expect(statement).toContain("event.turn_id = current_turn.turn_id");
    expect(statement).toContain("ORDER BY event.sequence DESC");
    expect(statement).toContain("'turn.completed'");
    expect(statement).toContain("'turn.failed'");
    expect(statement).toContain("'turn.interrupted'");
    expect(statement).toContain("THEN 'waiting_for_approval'");
    expect(statement).toContain("WHERE tasks.user_id = $1");
  });

  it("uses append order to distinguish same-timestamp turns for one active run", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE tasks (
          id UUID PRIMARY KEY, user_id UUID NOT NULL, workspace_id UUID,
          title TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL, archived_at TIMESTAMPTZ
        );
        CREATE TABLE sessions (
          id UUID PRIMARY KEY, user_id UUID NOT NULL, workspace_id UUID,
          thread_id TEXT, task_id UUID NOT NULL, title TEXT NOT NULL,
          title_source TEXT NOT NULL, title_version INTEGER NOT NULL,
          title_status TEXT NOT NULL DEFAULT 'ready',
          repository TEXT, active_run_id TEXT, mode TEXT NOT NULL,
          status TEXT NOT NULL, pinned_at TIMESTAMPTZ, archived_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE canonical_lifecycle_events (
          event_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          run_attempt_id TEXT NOT NULL, sequence BIGINT NOT NULL,
          idempotency_key TEXT NOT NULL, event_type TEXT NOT NULL,
          event_json JSONB NOT NULL, schema_version INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL, append_order BIGSERIAL NOT NULL
        );
      `);
      await db.query(
        `INSERT INTO tasks VALUES ($1, $2, NULL, 'Approval task', 'active', $3, $3, NULL)`,
        [
          "123e4567-e89b-42d3-a456-426614174000",
          "123e4567-e89b-42d3-a456-426614174001",
          NOW,
        ],
      );
      await db.query(
        `INSERT INTO sessions VALUES ($1, $2, NULL, $3, $4, 'Approval task', 'generated', 1, 'ready', 'acme/repo', $5, 'build', 'running', NULL, NULL, $6, $6)`,
        [
          "123e4567-e89b-42d3-a456-426614174002",
          "123e4567-e89b-42d3-a456-426614174001",
          "thread_1",
          "123e4567-e89b-42d3-a456-426614174000",
          "run_abc123",
          NOW,
        ],
      );

      const sharedTimestamp = new Date("2026-05-23T00:00:00.000Z");
      const olderTurnId = "trn_abc123__turn__older0001";
      const newerTurnId = "trn_abc123__turn__newer0001";
      await db.query(
        `INSERT INTO canonical_lifecycle_events
          (event_id, thread_id, turn_id, run_attempt_id, sequence, idempotency_key, event_type, event_json, schema_version, created_at)
         VALUES
          ('start-old', 'thread_1', $1, 'attempt-1', 2, 'start-old', 'turn.started', '{"type":"turn.started"}', 1, $3),
          ('unblock-old', 'thread_1', $1, 'attempt-1', 3, 'unblock-old', 'turn.blocking_changed', '{"payload":{"blockingState":{"kind":"none"}}}', 1, $3),
          ('start-new', 'thread_1', $2, 'attempt-1', 2, 'start-new', 'turn.started', '{"type":"turn.started"}', 1, $3),
          ('approval-new', 'thread_1', $2, 'attempt-1', 3, 'approval-new', 'turn.blocking_changed', '{"payload":{"blockingState":{"kind":"waiting_for_approval"}}}', 1, $3)`,
        [olderTurnId, newerTurnId, sharedTimestamp],
      );

      const repository = new PostgresTranscriptRepository(
        new PGliteSqlClient(db),
      );
      const result = await repository.listSessions(
        "123e4567-e89b-42d3-a456-426614174001",
      );

      expect(result.sessions[0]?.status).toBe("waiting_for_approval");

      await db.query(
        `INSERT INTO canonical_lifecycle_events
          (event_id, thread_id, turn_id, run_attempt_id, sequence, idempotency_key, event_type, event_json, schema_version, created_at)
         VALUES
          ('approval-cleared', 'thread_1', $1, 'attempt-1', 4, 'approval-cleared', 'turn.blocking_changed', '{"payload":{"blockingState":{"kind":"none"}}}', 1, $2)`,
        [newerTurnId, sharedTimestamp],
      );
      const clearedResult = await repository.listSessions(
        "123e4567-e89b-42d3-a456-426614174001",
      );
      expect(clearedResult.sessions[0]?.status).toBe("running");
    } finally {
      await db.close();
    }
  });
});

class PGliteSqlClient implements SqlClient {
  constructor(private readonly db: PGlite) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.db.query(statement, [...params]);
    return {
      rows: result.rows as Row[],
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await this.db.transaction(
      async (transaction) =>
        await callback(new PGliteSqlClient(transaction as unknown as PGlite)),
    );
  }
}

function createTaskRow(params: readonly SqlValue[]): SqlRow {
  return {
    task_id: params[0],
    task_user_id: params[1],
    task_workspace_id: params[2],
    task_title: params[3],
    task_status: "active",
    task_created_at: params[4],
    task_updated_at: params[4],
    task_archived_at: null,
  };
}

function createSessionRow(params: readonly SqlValue[]): SqlRow {
  return {
    session_id: params[0],
    session_user_id: params[1],
    session_workspace_id: params[2],
    session_thread_id: params[3],
    session_task_id: params[4],
    session_title: params[5],
    title_source: params[10] ?? "generated",
    repository: params[6],
    active_run_id: params[7],
    mode: params[8],
    session_status: params[9],
    pinned_at: null,
    archived_at: null,
    session_created_at: params[11],
    session_updated_at: params[11],
  };
}

function createResult<Row extends SqlRow>(row: SqlRow): SqlQueryResult<Row> {
  return {
    rows: [row as Row],
    rowCount: 1,
  };
}
