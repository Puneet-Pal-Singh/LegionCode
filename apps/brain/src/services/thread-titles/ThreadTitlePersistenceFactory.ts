import {
  PostgresThreadTitleRepository,
  type ThreadTitleRepository,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withSharedPersistenceClient } from "../sessions/TranscriptPersistenceFactory";

export async function withThreadTitleRepository<T>(
  env: Env,
  callback: (repository: ThreadTitleRepository) => Promise<T>,
): Promise<T> {
  if (env.AUTH_THREAD_TITLE_REPOSITORY) {
    return await callback(env.AUTH_THREAD_TITLE_REPOSITORY);
  }

  return await withSharedPersistenceClient(env, async (client) =>
    callback(new PostgresThreadTitleRepository(client)),
  );
}
