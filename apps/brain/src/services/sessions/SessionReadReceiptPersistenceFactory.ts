import {
  PostgresSessionReadReceiptRepository,
  type SessionReadReceiptRepository,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withSharedPersistenceClient } from "./TranscriptPersistenceFactory";

export async function withSessionReadReceiptRepository<T>(
  env: Env,
  callback: (repository: SessionReadReceiptRepository) => Promise<T>,
): Promise<T> {
  if (env.AUTH_SESSION_READ_RECEIPT_REPOSITORY) {
    return await callback(env.AUTH_SESSION_READ_RECEIPT_REPOSITORY);
  }
  return await withSharedPersistenceClient(env, (client) =>
    callback(new PostgresSessionReadReceiptRepository(client)),
  );
}
