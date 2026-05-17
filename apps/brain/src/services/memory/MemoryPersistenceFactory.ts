import {
  PostgresMemoryEventRepository,
  type MemoryEventRepository,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";

export async function withMemoryEventRepository<T>(
  env: Env,
  callback: (repository: MemoryEventRepository) => Promise<T>,
): Promise<T> {
  return await withBrainPersistenceRepository(
    env,
    env.AUTH_MEMORY_EVENT_REPOSITORY,
    (client) => new PostgresMemoryEventRepository(client),
    callback,
  );
}
