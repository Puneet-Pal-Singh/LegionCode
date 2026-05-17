/**
 * BYOK Schema Service
 *
 * Manages D1 database migrations for BYOK tables.
 * Ensures schema is ready before provider operations.
 */

import {
  ALL_BYOK_MIGRATIONS,
  PROVIDER_USER_MODEL_CACHE_BACKFILL_SCHEMA,
} from "./schema.js";

export interface IDatabase {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | undefined>;
      run(): Promise<{ success: boolean }>;
    };
    all<T = unknown>(): Promise<{ results: T[] }>;
    run(): Promise<{ success: boolean }>;
  };
}

interface MigrationRecord {
  migration_id: string;
  applied_at: string;
}

/**
 * Split a migration script into executable SQL statements.
 *
 * Keeps quoted string literals intact so statement separators inside values
 * do not break D1 bootstrap SQL.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let stringChar = "";

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];

    if (!inString && (char === "'" || char === '"')) {
      inString = true;
      stringChar = char;
      current += char;
      continue;
    }

    if (inString && char === stringChar) {
      if (sql[index + 1] === char) {
        current += char + char;
        index += 1;
      } else {
        inString = false;
        current += char;
      }
      continue;
    }

    if (!inString && char === ";") {
      if (hasExecutableSql(current)) {
        statements.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (hasExecutableSql(current)) {
    statements.push(current.trim());
  }

  return statements;
}

function hasExecutableSql(sql: string): boolean {
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith("--")) {
      continue;
    }
    return true;
  }

  return false;
}

/**
 * ByokSchemaService
 *
 * Runs migrations idempotently - skips already-applied migrations.
 */
export class ByokSchemaService {
  constructor(private db: IDatabase) {}

  /**
   * Ensure database is ready for BYOK operations
   *
   * Runs any pending migrations and returns when ready.
   */
  async ensureReady(): Promise<void> {
    const migrations = this.getMigrations();
    const applied = await this.getAppliedMigrations();

    for (const migration of migrations) {
      if (!applied.has(migration.id)) {
        await this.applyMigration(migration);
      }
    }

    await this.ensureRequiredTablesExist();
  }

  /**
   * Get list of migrations to apply
   */
  private getMigrations(): Array<{ id: string; sql: string }> {
    return ALL_BYOK_MIGRATIONS.map((sql, index) => ({
      id: `byok_migration_${index.toString().padStart(3, "0")}`,
      sql,
    }));
  }

  /**
   * Get set of already-applied migration IDs
   */
  private async getAppliedMigrations(): Promise<Set<string>> {
    try {
      const stmt = this.db.prepare(
        "SELECT migration_id FROM byok_schema_migrations",
      );
      const result = await stmt.all<MigrationRecord>();
      return new Set(result.results.map((r) => r.migration_id));
    } catch {
      // Table doesn't exist yet - return empty set
      return new Set();
    }
  }

  /**
   * Apply a single migration
   */
  private async applyMigration(migration: {
    id: string;
    sql: string;
  }): Promise<void> {
    console.log(`[byok/schema] Applying migration: ${migration.id}`);

    // Split SQL into individual statements
    const statements = splitSqlStatements(migration.sql);

    for (const [index, statement] of statements.entries()) {
      const sql = statement.trim();
      if (!sql) continue;

      const statementLabel = `${index + 1}/${statements.length}`;
      if (await this.isStatementAlreadySatisfied(sql)) {
        console.log(
          `[byok/schema] Skipping satisfied statement ${statementLabel} for ${migration.id}`,
        );
        continue;
      }

      console.log(
        `[byok/schema] Applying statement ${statementLabel} for ${migration.id}`,
      );
      const stmt = this.db.prepare(sql);
      try {
        const result = await stmt.run();
        if (!result.success) {
          throw new Error("Statement execution returned failure");
        }
      } catch (error) {
        throw new Error(
          `Migration ${migration.id} statement ${statementLabel} failed: ${sql}`,
          { cause: error },
        );
      }
    }

    // Record successful migration
    const insertStmt = this.db
      .prepare(
        "INSERT INTO byok_schema_migrations (migration_id, applied_at) VALUES (?, ?)",
      )
      .bind(migration.id, new Date().toISOString());

    const ledgerResult = await insertStmt.run();
    if (!ledgerResult.success) {
      throw new Error(`Failed to record migration ${migration.id} in ledger`);
    }

    console.log(`[byok/schema] Migration ${migration.id} applied successfully`);
  }

  private async isStatementAlreadySatisfied(sql: string): Promise<boolean> {
    const addColumnMatch = sql.match(
      /^\s*ALTER\s+TABLE\s+([a-zA-Z0-9_]+)\s+ADD\s+COLUMN\s+([a-zA-Z0-9_]+)/i,
    );
    if (!addColumnMatch) {
      return false;
    }

    const [, tableName, columnName] = addColumnMatch;
    try {
      const stmt = this.db.prepare(`PRAGMA table_info(${tableName})`);
      const result = await stmt.all<{ name: string }>();
      return result.results.some((column) => column.name === columnName);
    } catch {
      return false;
    }
  }

  private async ensureRequiredTablesExist(): Promise<void> {
    const requiredTables: Array<{ name: string; recoverySql: string }> = [
      {
        name: "provider_user_model_cache",
        recoverySql: PROVIDER_USER_MODEL_CACHE_BACKFILL_SCHEMA,
      },
    ];

    for (const table of requiredTables) {
      if (await this.tableExists(table.name)) {
        continue;
      }

      console.warn(
        `[byok/schema] Missing required table "${table.name}" after migration replay; applying recovery SQL.`,
      );
      await this.runStatements(table.recoverySql, `recovery:${table.name}`);
    }
  }

  private async tableExists(tableName: string): Promise<boolean> {
    try {
      const stmt = this.db.prepare(`PRAGMA table_info(${tableName})`);
      const result = await stmt.all<{ name: string }>();
      return result.results.length > 0;
    } catch {
      return false;
    }
  }

  private async runStatements(sql: string, label: string): Promise<void> {
    const statements = splitSqlStatements(sql);

    for (const [index, statement] of statements.entries()) {
      const executableSql = statement.trim();
      if (!executableSql) {
        continue;
      }

      const statementLabel = `${index + 1}/${statements.length}`;
      console.log(
        `[byok/schema] Applying statement ${statementLabel} for ${label}`,
      );
      const stmt = this.db.prepare(executableSql);
      try {
        const result = await stmt.run();
        if (!result.success) {
          throw new Error("Statement execution returned failure");
        }
      } catch (error) {
        throw new Error(
          `Recovery ${label} statement ${statementLabel} failed: ${executableSql}`,
          { cause: error },
        );
      }
    }
  }

}

/**
 * Create a schema service instance from D1 database
 */
export function createByokSchemaService(d1: D1Database): ByokSchemaService {
  return new ByokSchemaService(wrapD1Database(d1));
}

let schemaReadyCache = new WeakMap<D1Database, Promise<void>>();

export function ensureByokSchemaReady(d1: D1Database): Promise<void> {
  const cached = schemaReadyCache.get(d1);
  if (cached) {
    return cached;
  }

  const pending = createByokSchemaService(d1)
    .ensureReady()
    .catch((error) => {
      schemaReadyCache.delete(d1);
      throw error;
    });

  schemaReadyCache.set(d1, pending);
  return pending;
}

export function resetByokSchemaReadyCacheForTests(): void {
  schemaReadyCache = new WeakMap<D1Database, Promise<void>>();
}

/**
 * Wrap D1Database to match our IDatabase interface
 */
function wrapD1Database(d1: D1Database): IDatabase {
  return {
    prepare(sql: string) {
      const stmt = d1.prepare(sql);
      const bound = stmt.bind();
      return {
        bind(...params: unknown[]) {
          const boundStmt = stmt.bind(...params);
          return {
            async all<T = unknown>(): Promise<{ results: T[] }> {
              return (await boundStmt.all()) as { results: T[] };
            },
            async first<T = unknown>(): Promise<T | undefined> {
              return (await boundStmt.first()) as T | undefined;
            },
            async run(): Promise<{ success: boolean }> {
              return await boundStmt.run();
            },
          };
        },
        async all<T = unknown>(): Promise<{ results: T[] }> {
          return (await bound.all()) as { results: T[] };
        },
        async run(): Promise<{ success: boolean }> {
          return await bound.run();
        },
      };
    },
  };
}
