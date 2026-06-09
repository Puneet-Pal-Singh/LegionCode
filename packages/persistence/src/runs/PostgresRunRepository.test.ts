import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresRunRepository } from "./PostgresRunRepository.js";

class CapturingSqlClient implements SqlClient {
  public queries: Array<{ statement: string; params: readonly SqlValue[] }> =
    [];

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.queries.push({ statement, params });
    if (statement.includes("FROM run_steps s")) {
      return {
        rows: [
          {
            step_id: "123e4567-e89b-42d3-a456-426614174004",
            run_id: params[0],
            step_index: 1,
            step_type: "tool.completed",
            step_status: "completed",
            step_started_at: null,
            step_completed_at: null,
            step_payload_json: {},
            step_created_at: new Date(),
            step_updated_at: new Date(),
          } satisfies SqlRow,
        ] as Row[],
        rowCount: 1,
      };
    }

    if (statement.includes("INSERT INTO run_events")) {
      return {
        rows: [
          {
            event_id: "123e4567-e89b-42d3-a456-426614174005",
            run_id: params[0],
            session_id: params[1],
            event_type: params[2],
            payload_json: JSON.parse(String(params[3])),
            sequence: 1,
            idempotency_key: params[4],
            created_at: params[5],
          } satisfies SqlRow,
        ] as Row[],
        rowCount: 1,
      };
    }

    const now = params[12] instanceof Date ? params[12] : new Date();
    return {
      rows: [
        {
          id: params[0],
          user_id: params[1],
          workspace_id: params[2],
          session_id: params[3],
          task_id: params[4],
          status: typeof params[5] === "string" ? params[5] : "created",
          mode: typeof params[6] === "string" ? params[6] : "build",
          provider_id: params[7],
          model_id: params[8],
          branch: params[9],
          base_commit_sha: params[10],
          head_commit_sha: params[11],
          started_at: null,
          completed_at: null,
          created_at: now,
          updated_at: now,
        } satisfies SqlRow,
      ] as Row[],
      rowCount: 1,
    };
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return await callback(this);
  }
}

describe("PostgresRunRepository", () => {
  it("defaults ensured runs to created build rows", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresRunRepository(client);

    const run = await repository.ensureRun({
      id: "123e4567-e89b-42d3-a456-426614174000",
      userId: "123e4567-e89b-42d3-a456-426614174001",
      sessionId: "123e4567-e89b-42d3-a456-426614174002",
      taskId: "123e4567-e89b-42d3-a456-426614174003",
    });

    expect(run.status).toBe("created");
    expect(run.mode).toBe("build");
    expect(client.queries[0]?.params[5]).toBeNull();
    expect(client.queries[0]?.params[6]).toBeNull();
    expect(client.queries[0]?.statement).toContain(
      "COALESCE($6::text, 'created')",
    );
    expect(client.queries[0]?.statement).toContain(
      "status = COALESCE($6::text, runs.status)",
    );
  });

  it("qualifies run step columns when listing joined rows", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresRunRepository(client);

    const steps = await repository.listRunSteps(
      "123e4567-e89b-42d3-a456-426614174000",
      "123e4567-e89b-42d3-a456-426614174001",
    );

    expect(steps).toHaveLength(1);
    expect(client.queries[0]?.statement).toContain("s.id AS step_id");
    expect(client.queries[0]?.statement).toContain("JOIN runs r");
  });

  it("qualifies existing event columns when appending with the run lock CTE", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresRunRepository(client);

    const event = await repository.appendEvent({
      runId: "123e4567-e89b-42d3-a456-426614174000",
      sessionId: "123e4567-e89b-42d3-a456-426614174002",
      eventType: "runtime.tool.completed",
      payload: { ok: true },
      idempotencyKey: "runtime-tool-completed-1",
    });

    const statement = client.queries[0]?.statement ?? "";
    expect(event.sequence).toBe(1);
    expect(statement).toContain("SELECT id FROM runs WHERE id = $1 FOR UPDATE");
    expect(statement).toContain("run_events.id AS event_id");
    expect(statement).toContain("run_events.run_id = $1");
    expect(statement).toContain("$5::text IS NOT NULL");
    expect(statement).toContain("run_events.idempotency_key = $5::text");
    expect(statement).toContain("$5::text, $6 FROM next_seq");
  });
});
