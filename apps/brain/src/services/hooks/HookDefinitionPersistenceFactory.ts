import type { HookDefinitionRepository } from "./HookDefinitionRepository";
import { PostgresHookDefinitionRepository } from "./PostgresHookDefinitionRepository";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";
import type { Env } from "../../types/ai";

export async function withHookDefinitionRepository<T>(
  env: Env,
  callback: (repository: HookDefinitionRepository) => Promise<T>,
): Promise<T> {
  return await withBrainPersistenceRepository(
    env,
    env.AUTH_HOOK_DEFINITION_REPOSITORY,
    (client) => new PostgresHookDefinitionRepository(client),
    callback,
  );
}
