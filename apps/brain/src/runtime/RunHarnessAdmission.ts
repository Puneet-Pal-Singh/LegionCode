import { z } from "zod";
import {
  HarnessAdmissionSelectionSchema,
  type HarnessAdmissionSelection,
} from "@repo/platform-protocol";
import type { Env } from "../types/ai";
import type { ExecuteRunPayload } from "./parsing/ExecuteRunPayloadSchema";
import { DomainError } from "../domain/errors";
import { withTurnAdmissionRepository } from "../services/turn-admissions/TurnAdmissionPersistenceFactory";

const AdmittedCapture = z.object({
  harnessSelection: HarnessAdmissionSelectionSchema.nullish(),
});
/** P11 persists this receipt in the canonical admission transaction for all
 * initial/queue/resume paths. A dispatch capture is comparison evidence only.
 * Explicit Native (selection:null) keeps its environment/revision authorization;
 * legacy omitted captures retain the existing Native path. */
export async function readRunHarnessAdmission(
  env: Env,
  payload: ExecuteRunPayload,
): Promise<HarnessAdmissionSelection | null> {
  const requested = payload.input.harnessSelection;
  const identity = payload.identity;
  if (!identity || !payload.userId || !payload.workspaceId)
    throw conflict(payload, "Canonical execution scope is missing");
  const admission = await withTurnAdmissionRepository(env, (repository) =>
    repository.getByTurnId(identity.turnId),
  );
  if (
    !admission ||
    admission.state !== "admitted" ||
    admission.userId !== payload.userId ||
    admission.workspaceId !== payload.workspaceId ||
    admission.sessionId !== payload.sessionId ||
    admission.threadId !== identity.threadId ||
    admission.runAttemptId !== identity.runAttemptId ||
    admission.runId !== payload.runId
  )
    throw conflict(
      payload,
      "Canonical admission does not match execution scope",
    );
  const frozen = AdmittedCapture.parse(admission).harnessSelection ?? null;
  if (!requested && !frozen) return null;
  if (
    !requested ||
    !frozen ||
    requested.environmentId !== frozen.environmentId ||
    requested.selectionRevision !== frozen.selectionRevision ||
    (requested.selection === null) !== (frozen.selection === null)
  )
    throw conflict(
      payload,
      "Execution capture differs from immutable canonical admission",
    );
  const a = requested.selection,
    b = frozen.selection;
  if (
    a &&
    b &&
    (a.harness !== b.harness ||
      a.instanceId !== b.instanceId ||
      a.connectionId !== b.connectionId ||
      a.modelId !== b.modelId)
  )
    throw conflict(
      payload,
      "Execution account/model differs from immutable canonical admission",
    );
  return frozen;
}
function conflict(payload: ExecuteRunPayload, message: string): DomainError {
  return new DomainError(
    "HARNESS_ADMISSION_CONFLICT",
    message,
    409,
    false,
    payload.correlationId,
  );
}
