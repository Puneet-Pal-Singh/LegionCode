import {
  PostgresPermissionRepository,
  type PermissionRepository,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";

export async function withPermissionRepository<T>(
  env: Env,
  callback: (repository: PermissionRepository) => Promise<T>,
): Promise<T> {
  return await withBrainPersistenceRepository(
    env,
    env.AUTH_PERMISSION_REPOSITORY,
    (client) => new PostgresPermissionRepository(client),
    callback,
  );
}
