import type { SqlClient } from "../sql.js";
import type { MigrationLedger, SqlMigration } from "./types.js";

export class PostgresMigrationLedger implements MigrationLedger {
  async ensureReady(client: SqlClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async hasMigration(
    client: SqlClient,
    migrationId: string,
  ): Promise<boolean> {
    const result = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [
      migrationId,
    ]);
    return result.rowCount > 0;
  }

  async recordMigration(
    client: SqlClient,
    migration: SqlMigration,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO schema_migrations (id, description)
        VALUES ($1, $2)
        ON CONFLICT (id) DO NOTHING
      `,
      [migration.id, migration.description],
    );
  }
}
