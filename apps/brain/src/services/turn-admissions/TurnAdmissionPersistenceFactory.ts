import {
  PostgresTurnAdmissionRepository, TurnAdmissionConflictError,
  type TurnAdmissionRepository, type NativeRootAdmissionGuardInput,
} from "@repo/persistence";
import { AppServerEnvironmentIdSchema } from "@repo/platform-protocol";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";
import type { Env } from "../../types/ai";
import { DependencyError } from "../../domain/errors";
import { createNativeProviderAdmissionCapture } from "../providers/NativeProviderAdmissionCapture";

function expectedHarnessEnvironmentId(env: Env): string | undefined {
  if (env.APP_SERVER_ENVIRONMENT_ID === undefined) return undefined;
  const parsed = AppServerEnvironmentIdSchema.safeParse(env.APP_SERVER_ENVIRONMENT_ID);
  // Keep invalid placement distinct from absence. Only a NEW root assertion
  // rejects it; admitted receipts, continuation and recovery retain their owner.
  return parsed.success ? parsed.data : "";
}

function hostedHarnessExecutionUnavailable(): DependencyError {
  return new DependencyError("The selected hosted harness execution is unavailable", "hosted_harness_execution_unavailable", false);
}

export async function withTurnAdmissionRepository<T>(
  env: Env,
  callback: (repository: TurnAdmissionRepository) => Promise<T>,
): Promise<T> {
  const environmentId = expectedHarnessEnvironmentId(env);
  try {
    return await withBrainPersistenceRepository(
      env,
      env.AUTH_TURN_ADMISSION_REPOSITORY,
      (client) => new PostgresTurnAdmissionRepository(client, createNativeProviderAdmissionCapture(env), environmentId),
      callback,
    );
  } catch (error) {
    if (error instanceof TurnAdmissionConflictError && error.code === "hosted_harness_execution_unavailable")
      throw hostedHarnessExecutionUnavailable();
    throw error;
  }
}

/** Early scope-only refusal before Native preparation; final publication repeats
 * the same canonical check under its admission transaction. No picker capture is fabricated. */
export async function assertHostedNativeRootAdmissionAllowed(
  env: Env,
  input: NativeRootAdmissionGuardInput,
): Promise<void> {
  const captured = structuredClone(input);
  // Unconfigured placements retain the existing Native route and do not open a
  // new repository/client merely to assert an absent harness placement.
  if (expectedHarnessEnvironmentId(env) === undefined) return;
  await withTurnAdmissionRepository(env, async (repository) => {
    if (!repository.assertNativeRootAdmissionAllowed) throw hostedHarnessExecutionUnavailable();
    await repository.assertNativeRootAdmissionAllowed(captured);
  });
}
