import type { HarnessOperations } from "@legioncode/app-server/server";
import {
  HarnessAdmissionSelectionSchema,
  HarnessModelsResponseSchema,
  HarnessSelectionResponseSchema,
  HarnessStatusResponseSchema,
  type HarnessAdmissionSelection,
  type TurnScopeBootstrap,
} from "@repo/platform-protocol";
import { DomainError } from "../../domain/errors";
import { withTurnAdmissionRepository } from "../../services/turn-admissions/TurnAdmissionPersistenceFactory";
import type { Env } from "../../types/ai";

/** Preflight through the already-authorized P12 service. The canonical admission
 * transaction must still compare the revision and freeze account/policy/runtime
 * binding atomically before starting an external session. No credentials, quota
 * or Native provider preferences are used to infer the selected payer.
 */
export async function verifyHostedHarnessAdmission(input: {
  env: Env;
  userId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  identity: TurnScopeBootstrap;
  capture: HarnessAdmissionSelection;
  operations: HarnessOperations | undefined;
  correlationId: string;
}): Promise<HarnessAdmissionSelection> {
  const { capture, correlationId } = input;
  const admission = await withTurnAdmissionRepository(input.env, (repository) => repository.getByTurnId(input.identity.turnId));
  if (admission) {
    if (admission.userId !== input.userId || admission.workspaceId !== input.workspaceId ||
        admission.sessionId !== input.sessionId || admission.threadId !== input.identity.threadId ||
        admission.runAttemptId !== input.identity.runAttemptId || admission.runId !== input.runId) {
      throw new DomainError("TURN_SCOPE_MISMATCH", "Turn admission does not match the authorized request", 409, false, correlationId);
    }
    // Exact retries use the existing immutable admission/fingerprint and binding.
    // A later settings change cannot retarget that attempt. Changed content must
    // still be rejected by canonical admission, never repaired here from settings.
    if (admission.state === "admitted") return capture;
  }
  const operations = input.operations;
  if (!operations) throw new DomainError("HARNESS_ADMISSION_COMPOSITION_REQUIRED", "Harness admission is unavailable in this environment", 503, false, correlationId);
  const scope = { workspaceId: input.workspaceId, environmentId: capture.environmentId };
  const saved = HarnessSelectionResponseSchema.parse(await operations.readSelection({ ...scope, sessionId: input.sessionId, threadId: input.identity.threadId }));
  const requested = capture.selection;
  const selected = saved.selection;
  if (saved.workspaceId !== scope.workspaceId || saved.environmentId !== scope.environmentId ||
      saved.sessionId !== input.sessionId || saved.threadId !== input.identity.threadId ||
      saved.revision !== capture.selectionRevision ||
      (requested === null) !== (selected === null) ||
      (requested && selected && (requested.harness !== selected.harness || requested.instanceId !== selected.instanceId ||
        requested.connectionId !== selected.connectionId || requested.modelId !== selected.modelId))) {
    throw new DomainError("HARNESS_SELECTION_CHANGED", "Harness selection changed; capture the current selection before submitting", 409, false, correlationId);
  }
  if (selected) {
    // P12 checks credential ownership, route eligibility, refresh/revocation and
    // the instance's auth-owner generation before exposing a ready status/catalog.
    const status = HarnessStatusResponseSchema.parse(await operations.status(scope));
    const instance = status.instances.find((candidate) => candidate.workspaceId === scope.workspaceId && candidate.environmentId === scope.environmentId &&
      candidate.instanceId === selected.instanceId && candidate.connectionId === selected.connectionId && candidate.harness === selected.harness);
    if (!instance || instance.state !== "ready") throw new DomainError("HARNESS_UNAVAILABLE", "Selected harness connection is unavailable", 503, false, correlationId);
    const models = HarnessModelsResponseSchema.parse(await operations.models({ ...scope, instanceId: selected.instanceId, connectionId: selected.connectionId }));
    if (models.workspaceId !== scope.workspaceId || models.environmentId !== scope.environmentId || models.instanceId !== selected.instanceId ||
        models.connectionId !== selected.connectionId || models.availability !== "available" || !models.models.some((model) => model.id === selected.modelId)) {
      throw new DomainError("HARNESS_MODEL_UNAVAILABLE", "The model is unavailable for the selected harness connection", 409, false, correlationId);
    }
  }
  return HarnessAdmissionSelectionSchema.parse({ environmentId: saved.environmentId, selectionRevision: saved.revision, selection: selected });
}
