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
    expect(client.queries[1]?.params.slice(11, 15)).toEqual([
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
    expect(client.queries[1]?.params.slice(11, 15)).toEqual([
      true,
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
    expect(statement).not.toContain("$16");
    expect(client.queries[1]?.params).toHaveLength(15);
  });

  it("keeps transcript list filters on the outer message part join", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresTranscriptRepository(client, {
      now: () => NOW,
    });

    await repository.listTranscript({
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      runId: "123e4567-e89b-42d3-a456-426614174001",
      userId: "123e4567-e89b-42d3-a456-426614174002",
    });

    const statement = client.queries[0]?.statement ?? "";
    expect(statement).toContain("JOIN sessions s2 ON s2.id = p2.session_id");
    expect(statement).toContain("AND p.session_id = $1");
    expect(statement).toContain(
      "AND ($2::uuid IS NULL OR p.run_id = $2 OR m.run_id = $2)",
    );
    expect(statement).toContain("AND ($5::uuid IS NULL OR s2.user_id = $5)");
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
    session_task_id: params[3],
    session_title: params[4],
    title_source: params[9] ?? "generated",
    repository: params[5],
    active_run_id: params[6],
    mode: params[7],
    session_status: params[8],
    pinned_at: null,
    archived_at: null,
    session_created_at: params[10],
    session_updated_at: params[10],
  };
}

function createResult<Row extends SqlRow>(row: SqlRow): SqlQueryResult<Row> {
  return {
    rows: [row as Row],
    rowCount: 1,
  };
}
