import {
  PostgresArtifactRepository,
  type ArtifactRepository,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";

export async function withArtifactRepository<T>(
  env: Env,
  callback: (repository: ArtifactRepository) => Promise<T>,
): Promise<T> {
  return await withBrainPersistenceRepository(
    env,
    env.AUTH_ARTIFACT_REPOSITORY,
    (client) => new PostgresArtifactRepository(client),
    callback,
  );
}
