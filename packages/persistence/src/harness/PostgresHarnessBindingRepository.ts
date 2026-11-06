import { PostgresTurnAdmissionRepository } from "../turn-admissions/PostgresTurnAdmissionRepository.js";
import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import {
  HarnessPersistenceError,
  StoredHarnessSelectionSchema,
  StoredHarnessAttachmentSchema,
  harnessSelectionFingerprint,
  assertHarnessSelection,
  assertHarnessOrigin,
  assertHarnessAttachmentChange,
  validateHarnessObservation,
  assertEventScope,
  assertLearnedExternalTurn,
  sameHarnessOrigin,
  type StoredHarnessSelection,
  type StoredHarnessAttachment,
  type StoredHarnessBinding,
  type HarnessObservationCommit,
  type HarnessObservationAck,
  type HarnessBindingRepository,
  type HarnessExecutionClaimResult,
} from "@repo/event-store";
import type { SqlClient, SqlRow } from "../sql.js";
import { PostgresLifecycleEventStore } from "../lifecycle-events/PostgresLifecycleEventStore.js";

interface BindingRow extends SqlRow {
  selection_json: unknown;
  selection_fingerprint: string;
  attachment_json: unknown;
  external_turn_id: string | null;
  last_observation_sequence: number | string;
}
interface ReceiptRow extends SqlRow {
  observation_fingerprint: string;
  event_ids_json: unknown;
}
type Scope = Pick<StoredHarnessSelection, "userId" | "turnId" | "runAttemptId">;

/** Uses the admission lock and the canonical lifecycle writer, never a parallel log. */
export class PostgresHarnessBindingRepository implements HarnessBindingRepository {
  constructor(private readonly client: SqlClient) {}

  async freezeAndClaim(input: {
    selection: StoredHarnessSelection;
    claimId: string;
    events?: readonly LifecycleEvent[];
  }): Promise<HarnessExecutionClaimResult> {
    const selection = StoredHarnessSelectionSchema.parse(input.selection);
    if (!input.claimId || input.claimId.length > 4096)
      throw new HarnessPersistenceError(
        "admission_required",
        "Execution claim identity is invalid",
      );
    return this.client.transaction(async (tx) => {
      await lockCanonicalTurn(tx, selection.turnId);
      const claim = await new PostgresTurnAdmissionRepository(
        tx,
      ).claimExecution({ ...selection, claimId: input.claimId });
      if (claim.status === "conflict")
        throw new HarnessPersistenceError(
          "admission_required",
          "Owned admission does not match harness selection",
        );
      if (claim.status === "claimed") {
        const binding = await new PostgresHarnessBindingRepository(tx).freeze(
          selection,
          input.events,
        );
        return { status: claim.status, binding };
      }
      const binding = await readBinding(tx, selection, true);
      if (binding) assertHarnessSelection(binding.selection, selection);
      return { status: claim.status, binding };
    });
  }
  async markRecoveryRequired(input: {
    selection: StoredHarnessSelection;
    claimId: string;
  }): Promise<boolean> {
    return this.client.transaction(async (tx) => {
      await lockCanonicalTurn(tx, input.selection.turnId);
      await requiredBinding(tx, input.selection);
      return new PostgresTurnAdmissionRepository(tx).markRecoveryRequired({
        turnId: input.selection.turnId,
        claimId: input.claimId,
      });
    });
  }
  async freeze(
    value: StoredHarnessSelection,
    events: readonly LifecycleEvent[] = [],
  ): Promise<StoredHarnessBinding> {
    const selection = StoredHarnessSelectionSchema.parse(value);
    return this.client.transaction(async (tx) => {
      await lockCanonicalTurn(tx, selection.turnId);
      await requireAdmission(tx, selection);
      for (const event of events) assertEventScope(selection, event);
      await new PostgresLifecycleEventStore(tx).appendBatch(events);
      const existing = await readBinding(tx, selection, true);
      if (existing) {
        assertHarnessSelection(existing.selection, selection);
        return existing;
      }
      await tx.query(
        `INSERT INTO harness_bindings(turn_id,run_attempt_id,user_id,selection_json,selection_fingerprint)
        VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [
          selection.turnId,
          selection.runAttemptId,
          selection.userId,
          JSON.stringify(selection),
          harnessSelectionFingerprint(selection),
        ],
      );
      return {
        selection,
        attachment: null,
        externalTurnId: null,
        lastObservationSequence: 0,
      };
    });
  }
  async read(scope: Scope): Promise<StoredHarnessBinding | null> {
    return readBinding(this.client, scope, false);
  }

  async attach(input: {
    selection: StoredHarnessSelection;
    origin: StoredHarnessAttachment;
    expectedProcessGeneration: string | null;
    events?: readonly LifecycleEvent[];
  }): Promise<StoredHarnessBinding> {
    return this.client.transaction(async (tx) => {
      await lockCanonicalTurn(tx, input.selection.turnId);
      await requireAdmission(tx, input.selection);
      const binding = await requiredBinding(tx, input.selection);
      if (sameHarnessOrigin(binding.attachment, input.origin)) return binding;
      assertHarnessAttachmentChange(
        binding,
        input.origin,
        input.expectedProcessGeneration,
      );
      const retired = await tx.query("SELECT 1 FROM harness_process_generations WHERE turn_id=$1 AND process_generation=$2", [input.selection.turnId, input.origin.processGeneration]);
      if (retired.rows[0]) throw new HarnessPersistenceError("stale_origin", "A retired process generation cannot be reattached");
      await tx.query("INSERT INTO harness_process_generations(turn_id,process_generation,origin_json) VALUES ($1,$2,$3::jsonb)", [input.selection.turnId, input.origin.processGeneration, JSON.stringify(input.origin)]);
      for (const event of input.events ?? [])
        assertEventScope(input.selection, event);
      await new PostgresLifecycleEventStore(tx).appendBatch(input.events ?? []);
      await tx.query(
        "UPDATE harness_bindings SET attachment_json=$2::jsonb,last_observation_sequence=0 WHERE turn_id=$1",
        [input.selection.turnId, JSON.stringify(input.origin)],
      );
      return {
        ...binding,
        attachment: input.origin,
        lastObservationSequence: 0,
      };
    });
  }
  async lookupObservation(
    input: Omit<HarnessObservationCommit, "events">,
  ): Promise<HarnessObservationAck | null> {
    validateHarnessObservation({ ...input, events: [] });
    return this.client.transaction(async (tx) => {
      await lockCanonicalTurn(tx, input.selection.turnId);
      const binding = await requiredBinding(tx, input.selection);
      assertHarnessOrigin(binding.attachment, input.origin);
      assertLearnedExternalTurn(binding, input.learnedExternalTurnId);
      const result = await tx.query<ReceiptRow>(
        "SELECT observation_fingerprint,event_ids_json FROM harness_observation_receipts WHERE turn_id=$1 AND process_generation=$2 AND sequence=$3",
        [
          input.selection.turnId,
          input.origin.processGeneration,
          input.sequence,
        ],
      );
      const receipt = result.rows[0];
      if (!receipt) return null;
      if (receipt.observation_fingerprint !== input.observationFingerprint)
        throw new HarnessPersistenceError(
          "observation_conflict",
          "Observation sequence already contains different evidence",
        );
      const eventIds = jsonValue(receipt.event_ids_json);
      if (
        !Array.isArray(eventIds) ||
        !eventIds.every((id): id is string => typeof id === "string")
      )
        throw new HarnessPersistenceError(
          "corrupt",
          "Stored observation receipt is invalid",
        );
      return { sequence: input.sequence, eventIds, duplicate: true };
    });
  }
  async appendObservation(
    input: HarnessObservationCommit,
  ): Promise<HarnessObservationAck> {
    validateHarnessObservation(input);
    return this.client.transaction(async (tx) => {
      await lockCanonicalTurn(tx, input.selection.turnId);
      // Preserve lock order with admission and terminal append. Duplicate ACKs
      // remain readable after settlement, but new observations cannot revive it.
      const admission = await tx.query<{ execution_state: string }>(
        `SELECT a.execution_state FROM canonical_turn_admissions a
        JOIN sessions s ON s.id=a.session_id WHERE a.turn_id=$1 AND a.run_attempt_id=$2 AND s.user_id=$3 FOR UPDATE OF a`,
        [
          input.selection.turnId,
          input.selection.runAttemptId,
          input.selection.userId,
        ],
      );
      if (!admission.rows[0])
        throw new HarnessPersistenceError(
          "admission_required",
          "Owned admitted attempt was not found",
        );
      const binding = await requiredBinding(tx, input.selection);
      assertHarnessOrigin(binding.attachment, input.origin);
      assertLearnedExternalTurn(binding, input.learnedExternalTurnId);
      const receipt = await tx.query<ReceiptRow>(
        `SELECT observation_fingerprint,event_ids_json FROM harness_observation_receipts
        WHERE turn_id=$1 AND process_generation=$2 AND sequence=$3`,
        [
          input.selection.turnId,
          input.origin.processGeneration,
          input.sequence,
        ],
      );
      const prior = receipt.rows[0];
      if (prior) {
        if (prior.observation_fingerprint !== input.observationFingerprint)
          throw new HarnessPersistenceError(
            "observation_conflict",
            "Observation sequence already contains different evidence",
          );
        const eventIds = jsonValue(prior.event_ids_json);
        if (
          !Array.isArray(eventIds) ||
          !eventIds.every((id): id is string => typeof id === "string")
        )
          throw new HarnessPersistenceError(
            "corrupt",
            "Stored observation receipt is invalid",
          );
        return { sequence: input.sequence, eventIds, duplicate: true };
      }
      if (admission.rows[0].execution_state === "settled")
        throw new HarnessPersistenceError(
          "stale_origin",
          "Attempt is already settled",
        );
      if (input.sequence !== binding.lastObservationSequence + 1)
        throw new HarnessPersistenceError(
          "sequence_gap",
          "Harness observation sequence has a gap",
        );
      // Nested transaction is a savepoint on this SAME tx/connection. Returning
      // an ACK happens only after the enclosing transaction commits successfully.
      const events = await new PostgresLifecycleEventStore(tx).appendBatch(
        input.events,
      );
      const eventIds = events.map((event) => event.eventId);
      await tx.query(
        `INSERT INTO harness_observation_receipts(turn_id,process_generation,sequence,observation_fingerprint,event_ids_json)
        VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          input.selection.turnId,
          input.origin.processGeneration,
          input.sequence,
          input.observationFingerprint,
          JSON.stringify(eventIds),
        ],
      );
      await tx.query(
        "UPDATE harness_bindings SET last_observation_sequence=$2,external_turn_id=COALESCE(external_turn_id,$3) WHERE turn_id=$1",
        [
          input.selection.turnId,
          input.sequence,
          input.learnedExternalTurnId ?? null,
        ],
      );
      return { sequence: input.sequence, eventIds, duplicate: false };
    });
  }
}
async function requireAdmission(
  tx: SqlClient,
  value: StoredHarnessSelection,
): Promise<void> {
  const selection = StoredHarnessSelectionSchema.parse(value);
  const result = await tx.query(
    `SELECT a.turn_id,a.harness_admission_receipt_json FROM canonical_turn_admissions a JOIN sessions s ON s.id=a.session_id
    WHERE a.turn_id=$1 AND a.run_attempt_id=$2 AND a.session_id::text=$3 AND a.run_id=$4 AND a.workspace_id=$5
      AND a.thread_id=$6 AND s.user_id=$7 AND a.admission_state='admitted' AND a.execution_state IN ('running','recovery_required')
      AND a.execution_claim_id IS NOT NULL FOR UPDATE OF a`,
    [
      selection.turnId,
      selection.runAttemptId,
      selection.sessionId,
      selection.runId,
      selection.workspaceId,
      selection.threadId,
      selection.userId,
    ],
  );
  if (!result.rows[0])
    throw new HarnessPersistenceError(
      "admission_required",
      "Harness binding requires a matching claimed admission",
    );
  const receiptValue=result.rows[0].harness_admission_receipt_json;
  if(receiptValue==null)throw new HarnessPersistenceError("admission_required","Frozen admission selection receipt is missing");
  const receipt=(typeof receiptValue==="string"?JSON.parse(receiptValue):receiptValue) as {capture:{environmentId:string;selectionRevision:number;selection:{harness:string;instanceId:string;connectionId:string;modelId:string}|null};authOwnerGeneration:number;binding:unknown};
  const binding=JSON.parse(selection.selectionJson) as Record<string,unknown>;
  const chosen=receipt.capture?.selection;
  if(!chosen || binding.selectionRevision!==receipt.capture.selectionRevision || binding.environmentId!==receipt.capture.environmentId || binding.harness!==chosen.harness || binding.instanceId!==chosen.instanceId || binding.connectionId!==chosen.connectionId || binding.modelId!==chosen.modelId || binding.authOwnerGeneration!==receipt.authOwnerGeneration)
    throw new HarnessPersistenceError("binding_conflict","Runtime binding differs from admitted selection");
  if(receipt.binding!=null && JSON.stringify(receipt.binding)!==JSON.stringify(binding))
    throw new HarnessPersistenceError("binding_conflict","Full admitted binding is immutable");
  if(receipt.binding==null)await tx.query("UPDATE canonical_turn_admissions SET harness_admission_receipt_json=jsonb_set(harness_admission_receipt_json,'{binding}',$2::jsonb) WHERE turn_id=$1",[selection.turnId,JSON.stringify(binding)]);
}
async function requiredBinding(
  tx: SqlClient,
  selection: StoredHarnessSelection,
): Promise<StoredHarnessBinding> {
  const binding = await readBinding(tx, selection, true);
  if (!binding)
    throw new HarnessPersistenceError(
      "binding_conflict",
      "Owned harness binding was not found",
    );
  assertHarnessSelection(binding.selection, selection);
  return binding;
}
async function readBinding(
  tx: SqlClient,
  scope: Scope,
  lock: boolean,
): Promise<StoredHarnessBinding | null> {
  const result = await tx.query<BindingRow>(
    `SELECT selection_json,selection_fingerprint,attachment_json,external_turn_id,last_observation_sequence FROM harness_bindings
    WHERE turn_id=$1 AND run_attempt_id=$2 AND user_id=$3${lock ? " FOR UPDATE" : ""}`,
    [scope.turnId, scope.runAttemptId, scope.userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const sequence = Number(row.last_observation_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new HarnessPersistenceError(
      "corrupt",
      "Stored observation sequence is invalid",
    );
  const selection = StoredHarnessSelectionSchema.parse(
    jsonValue(row.selection_json),
  );
  if (
    selection.turnId !== scope.turnId ||
    selection.runAttemptId !== scope.runAttemptId ||
    selection.userId !== scope.userId ||
    harnessSelectionFingerprint(selection) !== row.selection_fingerprint
  )
    throw new HarnessPersistenceError(
      "corrupt",
      "Stored harness binding index is invalid",
    );
  return {
    selection,
    externalTurnId: row.external_turn_id,
    attachment:
      row.attachment_json === null
        ? null
        : StoredHarnessAttachmentSchema.parse(jsonValue(row.attachment_json)),
    lastObservationSequence: sequence,
  };
}
function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

async function lockCanonicalTurn(tx: SqlClient, turnId: string): Promise<void> {
  // Same turn-stream lock as PostgresLifecycleEventStore. Take it before row
  // locks so terminal projection cannot deadlock with observation ingress.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    turnId,
  ]);
}
