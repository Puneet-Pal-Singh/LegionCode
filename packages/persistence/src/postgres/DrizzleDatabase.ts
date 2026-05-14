import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "../schema/index.js";

export type PersistenceDatabase = NodePgDatabase<typeof schema>;

export async function withDrizzleDatabase<T>(
  connectionString: string,
  callback: (database: PersistenceDatabase) => Promise<T>,
): Promise<T> {
  const connection = new Client({ connectionString });
  await connection.connect();

  try {
    return await callback(drizzle(connection, { schema }));
  } finally {
    await connection.end();
  }
}
