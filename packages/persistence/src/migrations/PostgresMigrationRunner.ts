import type { SqlClient } from "../sql.js";
import type {
  MigrationLedger,
  MigrationRunResult,
  MigrationRunner,
  SqlMigration,
} from "./types.js";

export class PostgresMigrationRunner implements MigrationRunner {
  constructor(
    private readonly client: SqlClient,
    private readonly ledger: MigrationLedger,
  ) {}

  async runPending(
    migrations: readonly SqlMigration[],
  ): Promise<MigrationRunResult> {
    const applied: string[] = [];
    const skipped: string[] = [];

    await this.client.transaction(async (tx) => {
      await this.ledger.ensureReady(tx);

      for (const migration of migrations) {
        if (await this.ledger.hasMigration(tx, migration.id)) {
          skipped.push(migration.id);
          continue;
        }

        await applyMigration(tx, migration);
        await this.ledger.recordMigration(tx, migration);
        applied.push(migration.id);
      }
    });

    return { applied, skipped };
  }
}

async function applyMigration(
  client: SqlClient,
  migration: SqlMigration,
): Promise<void> {
  for (const statement of migration.statements) {
    await client.query(statement);
  }
}
