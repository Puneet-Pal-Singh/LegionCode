import {
  PostgresContextRepository,
  type ContextRepository,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";

export async function withContextRepository<T>(
  env: Env,
  callback: (repository: ContextRepository) => Promise<T>,
): Promise<T> {
  return await withBrainPersistenceRepository(
    env,
    env.AUTH_CONTEXT_REPOSITORY,
    (client) => new PostgresContextRepository(client),
    callback,
  );
}
