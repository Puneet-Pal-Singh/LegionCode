import {
  PostgresTurnAdmissionRepository,
  type TurnAdmissionRepository,
} from "@repo/persistence";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";
import type { Env } from "../../types/ai";

export async function withTurnAdmissionRepository<T>(
  env: Env,
  callback: (repository: TurnAdmissionRepository) => Promise<T>,
): Promise<T> {
  return await withBrainPersistenceRepository(
    env,
    env.AUTH_TURN_ADMISSION_REPOSITORY,
    (client) => new PostgresTurnAdmissionRepository(client),
    callback,
  );
}
