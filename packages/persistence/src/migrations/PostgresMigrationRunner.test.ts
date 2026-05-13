import { describe, expect, it } from "vitest";
import { PostgresMigrationRunner } from "./PostgresMigrationRunner.js";
import type { MigrationLedger, SqlMigration } from "./types.js";
import type { SqlClient, SqlQueryResult, SqlRow } from "../sql.js";

class RecordingSqlClient implements SqlClient {
  public readonly statements: string[] = [];

  constructor(
    private readonly failureStatement?: string,
    private readonly failureError: unknown = new Error(
      "database rejected statement",
    ),
  ) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
  ): Promise<SqlQueryResult<Row>> {
    this.statements.push(statement);
    if (statement === this.failureStatement) {
      throw this.failureError;
    }
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

class FakeLedger implements MigrationLedger {
  public readonly recorded: string[] = [];

  constructor(private readonly appliedIds: Set<string>) {}

  async ensureReady(): Promise<void> {}

  async hasMigration(_client: SqlClient, migrationId: string): Promise<boolean> {
    return this.appliedIds.has(migrationId);
  }

  async recordMigration(
    _client: SqlClient,
    migration: SqlMigration,
  ): Promise<void> {
    this.recorded.push(migration.id);
  }
}

describe("PostgresMigrationRunner", () => {
  it("applies only pending migrations", async () => {
    const client = new RecordingSqlClient();
    const ledger = new FakeLedger(new Set(["0001_done"]));
    const runner = new PostgresMigrationRunner(client, ledger);

    const result = await runner.runPending([
      { id: "0001_done", description: "done", statements: ["SELECT 1"] },
      { id: "0002_pending", description: "pending", statements: ["SELECT 2"] },
    ]);

    expect(result).toEqual({
      applied: ["0002_pending"],
      skipped: ["0001_done"],
    });
    expect(client.statements).toEqual(["SELECT 2"]);
    expect(ledger.recorded).toEqual(["0002_pending"]);
  });

  it("adds migration context to statement failures", async () => {
    const client = new RecordingSqlClient("SELECT broken");
    const ledger = new FakeLedger(new Set());
    const runner = new PostgresMigrationRunner(client, ledger);

    await expect(
      runner.runPending([
        {
          id: "0001_broken",
          description: "broken",
          statements: ["SELECT ok", "SELECT broken"],
        },
      ]),
    ).rejects.toThrow(
      "Failed to apply migration 0001_broken statement 2: database rejected statement",
    );
  });

  it("handles non-Error throwables with detail preservation", async () => {
    const client = new RecordingSqlClient(
      "SELECT broken",
      "custom string error",
    );
    const ledger = new FakeLedger(new Set());
    const runner = new PostgresMigrationRunner(client, ledger);

    await expect(
      runner.runPending([
        {
          id: "0001_broken",
          description: "broken",
          statements: ["SELECT broken"],
        },
      ]),
    ).rejects.toThrow(
      "Failed to apply migration 0001_broken statement 1: custom string error",
    );
  });

  it("handles object throwables by stringifying them", async () => {
    const client = new RecordingSqlClient("SELECT broken", {
      code: "X123",
      detail: "object error",
    });
    const ledger = new FakeLedger(new Set());
    const runner = new PostgresMigrationRunner(client, ledger);

    await expect(
      runner.runPending([
        {
          id: "0001_broken",
          description: "broken",
          statements: ["SELECT broken"],
        },
      ]),
    ).rejects.toThrow(
      'Failed to apply migration 0001_broken statement 1: {"code":"X123","detail":"object error"}',
    );
  });
});
