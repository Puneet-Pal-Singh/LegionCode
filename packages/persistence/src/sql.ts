import type { JsonValue } from "@repo/shared-types";

export type SqlValue = string | number | boolean | null | Date | JsonValue;
export type SqlRow = Record<string, unknown>;

export interface SqlQueryResult<Row extends SqlRow = SqlRow> {
  rows: Row[];
  rowCount: number;
}

export interface SqlClient {
  query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>>;

  transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T>;
}
