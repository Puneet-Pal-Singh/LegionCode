import { Client, Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
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
    const result = await this.connection.query(statement, params as any[]);
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

export class PgPoolSqlClient implements SqlClient {
  constructor(private readonly pool: Pool) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.pool.query(statement, params as any[]);
    return mapQueryResult<Row>(result);
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      return await new PgSqlClient(new PgPoolConnection(connection)).transaction(
        callback,
      );
    } finally {
      connection.release();
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
  callback: (client: PgSqlClient) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await callback(new PgSqlClient(new PgClientConnection(client)));
  } finally {
    await client.end();
  }
}

export function createPostgresSqlClient(connectionString: string): SqlClient {
  return new PgPoolSqlClient(new Pool({ connectionString }));
}

class PgClientConnection implements PgConnection {
  constructor(private readonly client: Client) {}

  async connect(): Promise<unknown> {
    return await this.client.connect();
  }

  async end(): Promise<void> {
    await this.client.end();
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    return await this.client.query<Row>(statement, params as any[]);
  }
}

class PgPoolConnection implements PgConnection {
  constructor(private readonly connection: PoolClient) {}

  async connect(): Promise<unknown> {
    return undefined;
  }

  async end(): Promise<void> {
    this.connection.release();
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    return await this.connection.query<Row>(statement, params as any[]);
  }
}

function mapQueryResult<Row extends SqlRow>(
  result: QueryResult<QueryResultRow>,
): SqlQueryResult<Row> {
  return {
    rows: result.rows as Row[],
    rowCount: result.rowCount ?? result.rows.length,
  };
}
