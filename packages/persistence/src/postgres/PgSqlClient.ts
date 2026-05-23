import { Client, Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";

const postgresPools = new Map<string, Pool>();

export interface PgConnection {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export class PgSqlClient implements SqlClient {
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(private readonly connection: PgConnection) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.connection.query(
      statement,
      toQueryParams(params),
    );
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    const scope = this.createTransactionScope();
    await this.query(scope.begin);
    this.transactionDepth += 1;
    try {
      const result = await callback(this);
      await this.query(scope.commit);
      return result;
    } catch (error) {
      await this.rollbackTransactionScope(scope.rollback, error);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private createTransactionScope(): {
    begin: string;
    commit: string;
    rollback: string;
  } {
    if (this.transactionDepth === 0) {
      return {
        begin: "BEGIN",
        commit: "COMMIT",
        rollback: "ROLLBACK",
      };
    }

    const savepoint = `shadowbox_sp_${(this.savepointSequence += 1)}`;
    return {
      begin: `SAVEPOINT ${savepoint}`,
      commit: `RELEASE SAVEPOINT ${savepoint}`,
      rollback: `ROLLBACK TO SAVEPOINT ${savepoint}`,
    };
  }

  private async rollbackTransactionScope(
    statement: string,
    error: unknown,
  ): Promise<void> {
    try {
      await this.query(statement);
    } catch (rollbackError) {
      attachRollbackError(error, rollbackError);
    }
  }
}

export class PgPoolSqlClient implements SqlClient {
  constructor(private readonly pool: Pool) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.pool.query(statement, toQueryParams(params));
    return mapQueryResult<Row>(result);
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.connect();
    try {
      return await new PgSqlClient(
        new PgPoolConnection(connection),
      ).transaction(callback);
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
  return new PgPoolSqlClient(getPostgresPool(connectionString));
}

function getPostgresPool(connectionString: string): Pool {
  const existing = postgresPools.get(connectionString);
  if (existing) {
    return existing;
  }
  const pool = new Pool({ connectionString });
  postgresPools.set(connectionString, pool);
  return pool;
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
    return await this.client.query<Row>(statement, toQueryParams(params));
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
    return await this.connection.query<Row>(statement, toQueryParams(params));
  }
}

function toQueryParams(params?: readonly unknown[]): unknown[] | undefined {
  return params ? [...params] : undefined;
}

function mapQueryResult<Row extends SqlRow>(
  result: QueryResult<QueryResultRow>,
): SqlQueryResult<Row> {
  return {
    rows: result.rows as Row[],
    rowCount: result.rowCount ?? result.rows.length,
  };
}
