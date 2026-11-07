import { AppServerOperationError } from "@legioncode/app-server/server";
import {
  PostgresHarnessAdmissionBindingPort,
  PostgresTurnAdmissionRepository,
  type SqlClient,
} from "@repo/persistence";
import type { HostedHarnessOperationContext } from "../../integration/app-server/HostedHarnessOperations";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";
import type { HarnessAttemptCredentialBinding } from "./HarnessConnectionService";

/** Credential custody consumes the existing admission/binding authority, rather
 * than reconstructing an active attempt from a subset of stored JSON fields. */
export async function authorizeHostedHarnessAttempt(
  env: Env,
  context: HostedHarnessOperationContext,
  binding: HarnessAttemptCredentialBinding,
  transaction?: SqlClient,
) {
  if (
    context.signal.aborted ||
    binding.userId !== context.userId ||
    binding.workspaceId !== context.workspaceId ||
    binding.environmentId !== context.environmentId
  )
    throw missing();
  if (transaction) {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [binding.turnId],
    );
    const owned = await transaction.query(
      `SELECT s.id FROM canonical_turn_admissions a
       JOIN sessions s ON s.id=a.session_id
       JOIN workspaces w ON w.id=s.workspace_id
       WHERE a.turn_id=$1 AND a.run_attempt_id=$2 AND s.user_id::text=$3
         AND a.workspace_id=$4 AND s.workspace_id::text=$4
         AND w.user_id::text=$3 AND w.status='active' AND s.archived_at IS NULL
         AND s.thread_id=a.thread_id
       FOR SHARE OF s,w`,
      [
        binding.turnId,
        binding.runAttemptId,
        binding.userId,
        binding.workspaceId,
      ],
    );
    if (!owned.rows[0]) throw missing();
  }
  const repositories = (client: SqlClient) => ({
    admissions: new PostgresTurnAdmissionRepository(client),
    bindings: new PostgresHarnessAdmissionBindingPort(client),
  });
  const selection = await withBrainPersistenceRepository(
    env,
    transaction ? repositories(transaction) : undefined,
    repositories,
    async ({ admissions, bindings }) => {
      const admission = await admissions.getByTurnId(binding.turnId);
      if (
        !admission ||
        admission.userId !== binding.userId ||
        admission.workspaceId !== binding.workspaceId ||
        admission.turnId !== binding.turnId ||
        admission.runAttemptId !== binding.runAttemptId ||
        admission.state !== "admitted" ||
        admission.executionState !== "running" ||
        !admission.harnessSelection?.selection ||
        !admission.requestFingerprint
      )
        throw missing();
      const principal = {
        userId: binding.userId,
        workspaceId: binding.workspaceId,
        environmentId: binding.environmentId,
        sessionId: admission.sessionId,
        threadId: admission.threadId,
        turnId: admission.turnId,
        runAttemptId: admission.runAttemptId,
        runId: admission.runId,
      };
      // Canonical owner validates the full envelope, admitted capture/fingerprint
      // and frozen selection. Current Settings never repair an existing binding.
      const selected = await bindings.lookupImmutable(
        principal,
        admission.harnessSelection,
        admission.requestFingerprint,
      );
      if (
        !selected ||
        selected.connectionId !== binding.connectionId ||
        selected.authOwnerGeneration !== binding.ownerGeneration
      )
        throw missing();
      // Recheck the durable execution claim after lookup, including Stop/recovery
      // fences and the canonical conversation owner, before credential access.
      await bindings.assertActive(principal, selected);
      return selected;
    },
  );
  if (context.signal.aborted) throw missing();
  return selection;
}

function missing() {
  return new AppServerOperationError(
    404,
    "not_found",
    "Harness resource not found",
  );
}
