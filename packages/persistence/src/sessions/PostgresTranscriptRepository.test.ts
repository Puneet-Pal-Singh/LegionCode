import { describe, expect, it } from "vitest";
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

    const statement = client.queries[0]?.statement ?? "";
    expect(statement).toContain("JOIN sessions s2 ON s2.id = p2.session_id");
    expect(statement).toContain("AND p.session_id = $1");
    expect(statement).toContain(
      "AND ($2::text IS NULL OR p.run_id = $2 OR m.run_id = $2)",
    );
    expect(statement).toContain("AND ($5::uuid IS NULL OR s2.user_id = $5)");
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
    expect(client.queries[1]?.statement).toContain(
      "s.thread_id AS session_thread_id",
    );
    expect(client.queries[1]?.statement).toContain("s.title_version");
  });
});

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
