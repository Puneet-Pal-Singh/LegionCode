import {
  PostgresThreadInputRepository,
  type ThreadInputRepository,
} from "@repo/persistence";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";
import type { Env } from "../../types/ai";

export async function withThreadInputRepository<T>(
  env: Env,
  callback: (repository: ThreadInputRepository) => Promise<T>,
): Promise<T> {
  return await withBrainPersistenceRepository(
    env,
    env.AUTH_THREAD_INPUT_REPOSITORY,
    (client) => new PostgresThreadInputRepository(client),
    callback,
  );
}
