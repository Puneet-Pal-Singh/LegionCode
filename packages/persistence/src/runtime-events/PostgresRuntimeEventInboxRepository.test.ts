import { describe, expect, it } from "vitest";
import { PostgresRuntimeEventInboxRepository } from "./PostgresRuntimeEventInboxRepository.js";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";

class CapturingSqlClient implements SqlClient {
  public statement = "";
  public params: readonly SqlValue[] = [];

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>> {
    this.statement = statement;
    this.params = params ?? [];

    const row = {
      id: "00000000-0000-0000-0000-000000000001",
      source: "secure-agent-api",
      event_type: "tool.completed",
      idempotency_key: "run-1:tool-1:completed",
      payload_json: { runId: "run-1" },
      payload_schema_version: 1,
      status: "received",
      error_message: null,
      received_at: "2026-05-13T00:00:00.000Z",
      processed_at: null,
      inserted: true,
    } satisfies SqlRow;

    return { rows: [row as Row], rowCount: 1 };
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

describe("PostgresRuntimeEventInboxRepository", () => {
  it("uses an insert-or-read query keyed by source and idempotency key", async () => {
    const client = new CapturingSqlClient();
    const repository = new PostgresRuntimeEventInboxRepository(client);

    const result = await repository.accept({
      source: "secure-agent-api",
      eventType: "tool.completed",
      idempotencyKey: "run-1:tool-1:completed",
      payloadSchemaVersion: 1,
      payload: { runId: "run-1" },
    });

    expect(result.inserted).toBe(true);
    expect(client.statement).toContain("ON CONFLICT (source, idempotency_key)");
    expect(client.params).toEqual([
      "secure-agent-api",
      "tool.completed",
      "run-1:tool-1:completed",
      '{"runId":"run-1"}',
      1,
    ]);
  });
});
