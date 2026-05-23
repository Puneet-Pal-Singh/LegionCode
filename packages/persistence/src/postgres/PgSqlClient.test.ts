import { describe, expect, it } from "vitest";
import { PgSqlClient, type PgConnection } from "./PgSqlClient.js";
import type { QueryResult, QueryResultRow } from "pg";

class RecordingPgConnection implements PgConnection {
  public readonly statements: string[] = [];

  constructor(private readonly failureStatement?: string) {}

  async connect(): Promise<void> {}

  async end(): Promise<void> {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
  ): Promise<QueryResult<Row>> {
    this.statements.push(statement);
    if (statement === this.failureStatement) {
      throw new Error(`failed ${statement}`);
    }
    return {
      rows: [{ value: "ok" }] as Row[],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    };
  }
}

describe("PgSqlClient", () => {
  it("maps pg query results to the SqlClient contract", async () => {
    const connection = new RecordingPgConnection();
    const client = new PgSqlClient(connection);

    const result = await client.query("SELECT 1");

    expect(result).toEqual({ rows: [{ value: "ok" }], rowCount: 1 });
  });

  it("wraps transaction callbacks in begin and commit", async () => {
    const connection = new RecordingPgConnection();
    const client = new PgSqlClient(connection);

    const result = await client.transaction(async (tx) => {
      await tx.query("SELECT inside");
      return "done";
    });

    expect(result).toBe("done");
    expect(connection.statements).toEqual(["BEGIN", "SELECT inside", "COMMIT"]);
  });

  it("rolls back failed transactions", async () => {
    const connection = new RecordingPgConnection();
    const client = new PgSqlClient(connection);

    await expect(
      client.transaction(async (tx) => {
        await tx.query("SELECT inside");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(connection.statements).toEqual([
      "BEGIN",
      "SELECT inside",
      "ROLLBACK",
    ]);
  });

  it("uses savepoints for nested transactions", async () => {
    const connection = new RecordingPgConnection();
    const client = new PgSqlClient(connection);

    await client.transaction(async (tx) => {
      await tx.query("SELECT outer before");
      await tx.transaction(async (nestedTx) => {
        await nestedTx.query("SELECT nested");
      });
      await tx.query("SELECT outer after");
    });

    expect(connection.statements).toEqual([
      "BEGIN",
      "SELECT outer before",
      "SAVEPOINT shadowbox_sp_1",
      "SELECT nested",
      "RELEASE SAVEPOINT shadowbox_sp_1",
      "SELECT outer after",
      "COMMIT",
    ]);
  });

  it("rolls back only the nested savepoint on nested transaction failure", async () => {
    const connection = new RecordingPgConnection();
    const client = new PgSqlClient(connection);
    const nestedError = new Error("nested failed");

    await client.transaction(async (tx) => {
      await expect(
        tx.transaction(async (nestedTx) => {
          await nestedTx.query("SELECT nested");
          throw nestedError;
        }),
      ).rejects.toBe(nestedError);
      await tx.query("SELECT outer still works");
    });

    expect(connection.statements).toEqual([
      "BEGIN",
      "SAVEPOINT shadowbox_sp_1",
      "SELECT nested",
      "ROLLBACK TO SAVEPOINT shadowbox_sp_1",
      "SELECT outer still works",
      "COMMIT",
    ]);
  });

  it("preserves the original transaction error when rollback fails", async () => {
    const connection = new RecordingPgConnection("ROLLBACK");
    const client = new PgSqlClient(connection);
    const originalError = new Error("callback failed");

    await expect(
      client.transaction(async () => {
        throw originalError;
      }),
    ).rejects.toBe(originalError);
    expect(originalError.cause).toEqual(new Error("failed ROLLBACK"));
    expect(connection.statements).toEqual(["BEGIN", "ROLLBACK"]);
  });
});
