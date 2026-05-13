import { Client } from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";

export interface PgConnection {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export class PgSqlClient implements SqlClient {
  constructor(private readonly connection: PgConnection) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.connection.query(statement, params);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    await this.query("BEGIN");
    try {
      const result = await callback(this);
      await this.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.query("ROLLBACK");
      } catch (rollbackError) {
        attachRollbackError(error, rollbackError);
      }
      throw error;
    }
  }
}

function attachRollbackError(error: unknown, rollbackError: unknown): void {
  if (error instanceof Error) {
    error.cause ??= rollbackError;
  }
}

export async function withPostgresSqlClient<T>(
  connectionString: string,
  callback: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const connection = new Client({ connectionString });
  await connection.connect();

  try {
    return await callback(new PgSqlClient(connection));
  } finally {
    await connection.end();
  }
}
