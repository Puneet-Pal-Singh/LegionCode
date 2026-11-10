import {
  HarnessAdmissionSelectionSchema,
  HarnessSelectionSchema,
  userIdFromExternalId,
  workspaceIdFromExternalId,
  type HarnessAdmissionSelection,
  type HarnessSelection,
} from "@repo/platform-protocol";
import {
  HarnessSessionSchema, HarnessStartCommandSchema, HarnessOpeningIntentSchema,
  type HarnessSession,
  type HarnessStartCommand,
  type HarnessOpeningIntent,
} from "@repo/worker-protocol";
import {
  HarnessPersistenceError,
  assertHarnessSelection,
  createStableEventFingerprint,
  type StoredHarnessSelection,
} from "@repo/event-store";
import type { SqlClient, SqlRow } from "../sql.js";
import { PostgresHarnessBindingRepository } from "./PostgresHarnessBindingRepository.js";
import { PostgresHarnessObservationCommitPort } from "./PostgresHarnessObservationCommitPort.js";

type Principal = Omit<StoredHarnessSelection, "selectionJson"> & {
  environmentId: string;
};
interface AdmissionRow extends SqlRow {
  request_fingerprint: string | null;
  harness_admission_receipt_json: unknown;
  execution_state: string;
  execution_claim_id: string | null;
}
/** Structural implementation of the real Brain HarnessAdmissionBindingPort.
 * The existing admission, binding and canonical writer remain the sole authority. */
export class PostgresHarnessAdmissionBindingPort {
  constructor(private readonly client: SqlClient) {}
  async lookupImmutable(
    principal: Principal,
    expected: HarnessAdmissionSelection,
    admissionFingerprint: string,
  ): Promise<HarnessSelection | null> {
    return this.client.transaction(async (tx) => {
      await lock(tx, principal.turnId);
      await this.receipt(tx, principal, expected, admissionFingerprint);
      const binding = await new PostgresHarnessBindingRepository(tx).read(
        principal,
      );
      if (!binding) return null;
      const selection = HarnessSelectionSchema.parse(
        JSON.parse(binding.selection.selectionJson),
      );
      assertHarnessSelection(binding.selection, envelope(principal, selection));
      this.validate(principal, selection, expected);
      return selection;
    });
  }
  async freezeAndClaim(input: {
    principal: Principal;
    selection: HarnessSelection;
    claimId: string;
    expectedSelection: HarnessAdmissionSelection;
    admissionFingerprint: string;
  }): Promise<"claimed" | "already_claimed" | "recovery_required" | "settled"> {
    const { principal } = input;
    const selection = HarnessSelectionSchema.parse(input.selection);
    const expected = HarnessAdmissionSelectionSchema.parse(
      input.expectedSelection,
    );
    this.validate(principal, selection, expected);
    return this.client.transaction(async (tx) => {
      await lock(tx, principal.turnId);
      // Same session lock as selection CAS and canonical admission, before row locks.
      const session = await tx.query(
        "SELECT id FROM sessions WHERE id::text=$1 AND user_id::text=$2 AND workspace_id::text=$3 AND thread_id=$4 FOR UPDATE",
        [
          principal.sessionId,
          principal.userId,
          principal.workspaceId,
          principal.threadId,
        ],
      );
      if (!session.rows[0]) reject("Owned canonical conversation missing");
      await this.receipt(tx, principal, expected, input.admissionFingerprint);
      const repository = new PostgresHarnessBindingRepository(tx);
      const prior = await repository.read(principal);
      if (prior) {
        assertHarnessSelection(prior.selection, envelope(principal, selection));
        return (
          await repository.freezeAndClaim({
            selection: envelope(principal, selection),
            claimId: input.claimId,
          })
        ).status;
      }
      const current = await tx.query<{
        revision: string | number;
        selection_json: unknown;
      }>(
        `SELECT revision,selection_json FROM harness_next_selections WHERE user_id::text=$1 AND workspace_id=$2 AND environment_id=$3 AND session_id::text=$4 AND thread_id=$5 FOR UPDATE`,
        [
          principal.userId,
          principal.workspaceId,
          principal.environmentId,
          principal.sessionId,
          principal.threadId,
        ],
      );
      const row = current.rows[0];
      if (
        !row ||
        Number(row.revision) !== expected.selectionRevision ||
        !same(json(row.selection_json), expected.selection)
      )
        reject(
          "Authoritative harness selection changed before execution claim",
        );
      const configured = await tx.query(
        `SELECT i.instance_id FROM harness_configured_instances i JOIN provider_credentials c ON c.id=i.connection_id
        WHERE i.user_id::text=$1 AND i.workspace_id=$2 AND i.environment_id=$3 AND i.instance_id=$4 AND i.harness=$5 AND i.connection_id::text=$6 AND i.auth_owner_generation=$7
        AND c.user_id=i.user_id AND c.auth_owner_generation=i.auth_owner_generation AND c.status='connected' AND c.deleted_at IS NULL AND c.refresh_claim_id IS NULL FOR SHARE OF i,c`,
        [
          principal.userId,
          principal.workspaceId,
          principal.environmentId,
          selection.instanceId,
          selection.harness,
          selection.connectionId,
          selection.authOwnerGeneration,
        ],
      );
      if (!configured.rows[0])
        reject(
          "Selected configured instance/account generation is unavailable",
        );
      return (
        await repository.freezeAndClaim({
          selection: envelope(principal, selection),
          claimId: input.claimId,
        })
      ).status;
    });
  }
  observationsForAttempt(principal: Principal, selection: HarnessSelection) {
    this.validate(principal, selection, {
      environmentId: principal.environmentId,
      selectionRevision: selection.selectionRevision,
      selection: {
        harness: selection.harness,
        instanceId: selection.instanceId,
        connectionId: selection.connectionId,
        modelId: selection.modelId,
      },
    });
    return new PostgresHarnessObservationCommitPort(
      this.client,
      envelope(principal, selection),
    );
  }
  async reserveOpening(input: { principal: Principal; selection: HarnessSelection; command: HarnessStartCommand; intent: HarnessOpeningIntent }): Promise<void> {
    input = { ...input, principal: { ...input.principal }, selection: HarnessSelectionSchema.parse(input.selection),
      intent: HarnessOpeningIntentSchema.parse(input.intent), command: HarnessStartCommandSchema.parse(input.command) };
    await this.client.transaction(async (tx) => {
      await lock(tx, input.principal.turnId);
      await this.active(tx, input.principal, input.selection);
      const result = await new PostgresHarnessBindingRepository(tx).reserveOpening({
        selection: envelope(input.principal, input.selection), command: input.command, intent: input.intent,
      });
      if (result.status !== "reserved") reject("Existing opening requires explicit recovery");
    });
  }
  async beginOpeningDispatch(input: { principal: Principal; selection: HarnessSelection; intent: HarnessOpeningIntent }): Promise<void> {
    input = { ...input, principal: { ...input.principal }, selection: HarnessSelectionSchema.parse(input.selection),
      intent: HarnessOpeningIntentSchema.parse(input.intent) };
    await this.client.transaction(async (tx) => {
      await lock(tx, input.principal.turnId);
      await this.active(tx, input.principal, input.selection);
      await new PostgresHarnessBindingRepository(tx).beginOpeningDispatch({
        selection: envelope(input.principal, input.selection), intent: input.intent,
      });
    });
  }
  async acknowledgeOpening(input: { principal: Principal; selection: HarnessSelection; intent: HarnessOpeningIntent; session: HarnessSession }): Promise<void> {
    input = { ...input, principal: { ...input.principal }, selection: HarnessSelectionSchema.parse(input.selection),
      intent: HarnessOpeningIntentSchema.parse(input.intent), session: HarnessSessionSchema.parse(input.session) };
    const session = HarnessSessionSchema.parse(input.session);
    if (session.runAttemptId !== input.selection.runAttemptId || session.instanceId !== input.selection.instanceId ||
        session.processGeneration !== input.intent.processGeneration) reject("Opening acknowledgement identity mismatch");
    await this.client.transaction(async (tx) => {
      await lock(tx, input.principal.turnId);
      await new PostgresHarnessBindingRepository(tx).acknowledgeOpening({
        selection: envelope(input.principal, input.selection), intent: input.intent,
        origin: { instanceId: session.instanceId, externalSessionId: session.externalSessionId,
          processGeneration: session.processGeneration, authOwnerGeneration: input.selection.authOwnerGeneration },
      });
    });
  }
  async attach(input: {
    principal: Principal;
    selection: HarnessSelection;
    session: HarnessSession;
  }): Promise<void> {
    const session = HarnessSessionSchema.parse(input.session);
    const selection = HarnessSelectionSchema.parse(input.selection);
    const stored = envelope(input.principal, selection);
    if (
      session.runAttemptId !== selection.runAttemptId ||
      session.instanceId !== selection.instanceId
    )
      reject("Learned session does not match frozen attempt");
    await this.client.transaction(async (tx) => {
      await lock(tx, input.principal.turnId);
      await this.active(tx, input.principal, selection);
      const repo = new PostgresHarnessBindingRepository(tx);
      const prior = await repo.read(input.principal);
      if (!prior) reject("Frozen binding missing");
      // A changed process generation requires an explicit recovery owner; ordinary
      // open must never silently replace an already attached private session.
      if (
        prior.attachment &&
        (prior.attachment.processGeneration !== session.processGeneration ||
          prior.attachment.externalSessionId !== session.externalSessionId)
      )
        reject("Session generation replacement requires explicit recovery");
      await repo.attach({
        selection: stored,
        origin: {
          instanceId: session.instanceId,
          externalSessionId: session.externalSessionId,
          processGeneration: session.processGeneration,
          authOwnerGeneration: selection.authOwnerGeneration,
        },
        expectedProcessGeneration: prior.attachment?.processGeneration ?? null,
      });
    });
  }
  async assertActive(
    principal: Principal,
    selection: HarnessSelection,
  ): Promise<void> {
    await this.client.transaction(async (tx) => {
      await lock(tx, principal.turnId);
      await this.active(tx, principal, selection);
    });
  }
  private async active(
    tx: SqlClient,
    principal: Principal,
    selection: HarnessSelection,
  ) {
    const parsed = HarnessSelectionSchema.parse(selection);
    const row = await this.receipt(
      tx,
      principal,
      {
        environmentId: parsed.environmentId,
        selectionRevision: parsed.selectionRevision,
        selection: {
          harness: parsed.harness,
          instanceId: parsed.instanceId,
          connectionId: parsed.connectionId,
          modelId: parsed.modelId,
        },
      },
      undefined,
    );
    if (row.execution_state !== "running" || !row.execution_claim_id)
      reject("Attempt is fenced or no longer active");
    const binding = await new PostgresHarnessBindingRepository(tx).read(
      principal,
    );
    if (!binding) reject("Frozen binding missing");
    assertHarnessSelection(binding.selection, envelope(principal, parsed));
  }
  private async receipt(
    tx: SqlClient,
    p: Principal,
    expected: HarnessAdmissionSelection,
    fingerprint: string | undefined,
  ): Promise<AdmissionRow> {
    const capture = HarnessAdmissionSelectionSchema.parse(expected);
    if (capture.environmentId !== p.environmentId)
      reject("Admission environment mismatch");
    const rows = await tx.query<AdmissionRow>(
      `SELECT a.request_fingerprint,a.harness_admission_receipt_json,a.execution_state,a.execution_claim_id FROM canonical_turn_admissions a JOIN sessions s ON s.id=a.session_id
      WHERE a.turn_id=$1 AND a.run_attempt_id=$2 AND a.session_id::text=$3 AND a.run_id=$4 AND a.thread_id=$5 AND a.workspace_id=$6 AND s.user_id::text=$7 AND s.workspace_id::text=$6 AND s.thread_id=$5 AND a.admission_state='admitted' FOR UPDATE OF a`,
      [
        p.turnId,
        p.runAttemptId,
        p.sessionId,
        p.runId,
        p.threadId,
        p.workspaceId,
        p.userId,
      ],
    );
    const row = rows.rows[0];
    if (
      !row ||
      !row.request_fingerprint ||
      row.harness_admission_receipt_json == null
    )
      reject("Owned immutable admitted selection receipt missing");
    const receipt = json(row.harness_admission_receipt_json) as {
      capture: unknown;
      requestFingerprint: unknown;
    };
    if (
      !same(receipt.capture, capture) ||
      receipt.requestFingerprint !== row.request_fingerprint ||
      (fingerprint !== undefined && row.request_fingerprint !== fingerprint)
    )
      reject("Admitted capture or fingerprint conflicts");
    return row;
  }
  private validate(
    p: Principal,
    selection: HarnessSelection,
    expected: HarnessAdmissionSelection,
  ) {
    const capture = HarnessAdmissionSelectionSchema.parse(expected);
    const selected = capture.selection;
    if (
      !selected ||
      selection.userId !== userIdFromExternalId(p.userId) ||
      selection.workspaceId !== workspaceIdFromExternalId(p.workspaceId) ||
      selection.environmentId !== p.environmentId ||
      capture.environmentId !== p.environmentId ||
      selection.threadId !== p.threadId ||
      selection.turnId !== p.turnId ||
      selection.runAttemptId !== p.runAttemptId ||
      selection.runId !== p.runId ||
      selection.selectionRevision !== capture.selectionRevision ||
      selection.harness !== selected.harness ||
      selection.instanceId !== selected.instanceId ||
      selection.connectionId !== selected.connectionId ||
      selection.modelId !== selected.modelId
    )
      reject("Resolved runtime binding differs from admitted capture");
  }
}
function envelope(
  p: Principal,
  selection: HarnessSelection,
): StoredHarnessSelection {
  return {
    userId: p.userId,
    workspaceId: p.workspaceId,
    sessionId: p.sessionId,
    threadId: p.threadId,
    turnId: p.turnId,
    runAttemptId: p.runAttemptId,
    runId: p.runId,
    selectionJson: JSON.stringify(HarnessSelectionSchema.parse(selection)),
  };
}
function same(a: unknown, b: unknown) {
  return createStableEventFingerprint(a) === createStableEventFingerprint(b);
}
function json(v: unknown): unknown {
  return typeof v === "string" ? (JSON.parse(v) as unknown) : v;
}
async function lock(tx: SqlClient, id: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [id]);
}
function reject(message: string): never {
  throw new HarnessPersistenceError("binding_conflict", message);
}
