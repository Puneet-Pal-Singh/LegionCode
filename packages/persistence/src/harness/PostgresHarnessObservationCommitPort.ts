import {
  HarnessObservationSchema,
  HarnessRequestOriginSchema,
  HarnessSessionSchema,
  type HarnessObservation,
  type HarnessRequestOrigin,
  type HarnessSession,
  type HarnessCommitAck,
  type HarnessQuiescence,
} from "@repo/worker-protocol";
import {
  LifecycleEventSchema,
  HarnessSelectionSchema,
  userIdFromExternalId,
  workspaceIdFromExternalId,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import {
  HarnessPersistenceError,
  StoredHarnessSelectionSchema,
  assertHarnessOrigin,
  assertHarnessSelection,
  createStableEventFingerprint,
  fingerprintHarnessObservation,
  rethrowHarnessCommitFailure,
  type StoredHarnessSelection,
  type HarnessObservationCommit,
} from "@repo/event-store";
import type { SqlClient, SqlRow } from "../sql.js";
import { PostgresHarnessBindingRepository } from "./PostgresHarnessBindingRepository.js";

type PendingRequest = Extract<
  HarnessObservation["payload"],
  { kind: "approval_requested" | "user_input_requested" }
>;
interface RecoveryReceipt extends SqlRow {
  sequence: string | number;
  observation_fingerprint: string;
  recovery_observation_json: unknown;
  event_ids_json: unknown;
  consumed: boolean;
}
/** Structural implementation of P04's HarnessObservationCommitPort. All mutations
 * use the existing canonical writer on the caller's pinned SQL transaction. */
export class PostgresHarnessObservationCommitPort {
  readonly selection: StoredHarnessSelection;
  constructor(
    private readonly client: SqlClient,
    selection: StoredHarnessSelection,
  ) {
    this.selection = StoredHarnessSelectionSchema.parse(selection);
    const binding = HarnessSelectionSchema.parse(
      JSON.parse(this.selection.selectionJson),
    );
    if (
      binding.userId !== userIdFromExternalId(selection.userId) ||
      binding.workspaceId !==
        workspaceIdFromExternalId(selection.workspaceId) ||
      binding.turnId !== selection.turnId ||
      binding.runAttemptId !== selection.runAttemptId ||
      binding.threadId !== selection.threadId ||
      binding.runId !== selection.runId
    )
      reject("Frozen runtime binding identity mismatch");
  }
  async lookup(value: HarnessObservation): Promise<HarnessCommitAck | null> {
    const observation = HarnessObservationSchema.parse(value);
    const input = await this.input(observation);
    const ack = await new PostgresHarnessBindingRepository(
      this.client,
    ).lookupObservation(input);
    return ack
      ? { session: observation.session, committedSequence: ack.sequence }
      : null;
  }
  async commit(input: {
    observation: HarnessObservation;
    events: readonly LifecycleEvent[];
  }): Promise<HarnessCommitAck> {
    const observation = HarnessObservationSchema.parse(input.observation);
    const commit = { ...(await this.input(observation)), events: input.events };
    if (
      observation.payload.kind === "approval_requested" ||
      observation.payload.kind === "user_input_requested"
    ) {
      this.checkRequest(observation, observation.payload);
      if (
        !input.events.some((event) =>
          requestMatches(
            observation.payload as PendingRequest,
            LifecycleEventSchema.parse(event),
          ),
        )
      )
        reject("Request ingress requires its canonical request append");
    }
    if (
      observation.payload.kind === "quiescence" &&
      !sameSession(observation.payload.evidence.session, observation.session)
    )
      reject("Quiescence session mismatch");
    const retained =
      observation.payload.kind === "approval_requested" ||
      observation.payload.kind === "user_input_requested" ||
      observation.payload.kind === "external_terminal" ||
      observation.payload.kind === "quiescence";
    try {
      return await this.client.transaction(async (tx) => {
        await turnLock(tx, this.selection.turnId);
        const ack = await new PostgresHarnessBindingRepository(
          tx,
        ).appendObservation(commit);
        if (retained) {
          // The receipt and canonical events cannot commit without the recovery fact.
          await tx.query(
            `UPDATE harness_observation_receipts SET recovery_observation_json=$4::jsonb
          WHERE turn_id=$1 AND process_generation=$2 AND sequence=$3 AND recovery_observation_json IS NULL`,
            [
              this.selection.turnId,
              observation.session.processGeneration,
              observation.sequence,
              JSON.stringify(observation),
            ],
          );
          const stored = await tx.query<{ recovery_observation_json: unknown }>(
            `SELECT recovery_observation_json FROM harness_observation_receipts WHERE turn_id=$1 AND process_generation=$2 AND sequence=$3`,
            [
              this.selection.turnId,
              observation.session.processGeneration,
              observation.sequence,
            ],
          );
          if (
            createStableEventFingerprint(
              json(stored.rows[0]?.recovery_observation_json),
            ) !== createStableEventFingerprint(observation)
          )
            reject("Recovery fact conflicts with committed ingress");
        }
        return {
          session: observation.session,
          committedSequence: ack.sequence,
        };
      });
    } catch (error) {
      rethrowHarnessCommitFailure(error);
    }
  }
  async recover(value: HarnessSession): Promise<{
    session: HarnessSession;
    lifecycleEvents: readonly LifecycleEvent[];
    lastSequence: number;
    externalTurnId: string | null;
    terminal: Extract<
      HarnessObservation["payload"],
      { kind: "external_terminal" }
    > | null;
    quiescence: HarnessQuiescence | null;
    pendingRequests: readonly PendingRequest[];
  }> {
    const session = HarnessSessionSchema.parse(value);
    return this.client.transaction(async (tx) => {
      await turnLock(tx, this.selection.turnId);
      const binding = await this.active(tx, session);
      const coverage = await tx.query<{
        count: string;
        first: string | null;
        last: string | null;
      }>(
        "SELECT count(*)::text AS count,min(sequence)::text AS first,max(sequence)::text AS last FROM harness_observation_receipts WHERE turn_id=$1 AND process_generation=$2",
        [this.selection.turnId, session.processGeneration],
      );
      const summary = coverage.rows[0];
      if (
        !summary ||
        Number(summary.count) !== binding.lastObservationSequence ||
        (binding.lastObservationSequence > 0 &&
          (Number(summary.first) !== 1 ||
            Number(summary.last) !== binding.lastObservationSequence))
      )
        reject("Committed ingress coverage is incomplete");
      const result = await tx.query<{ event_json: unknown }>(
        `SELECT event_json FROM canonical_lifecycle_events WHERE turn_id=$1 AND run_attempt_id=$2 ORDER BY sequence LIMIT 10001`,
        [this.selection.turnId, this.selection.runAttemptId],
      );
      if (result.rows.length > 10000)
        reject("Canonical recovery exceeds bounded replay window");
      const lifecycleEvents = result.rows.map((r) =>
        LifecycleEventSchema.parse(json(r.event_json)),
      );
      for (let i = 0; i < lifecycleEvents.length; i++) {
        const event = lifecycleEvents[i]!;
        if (
          event.sequence !== i + 1 ||
          event.turnId !== this.selection.turnId ||
          event.runAttemptId !== this.selection.runAttemptId ||
          event.threadId !== this.selection.threadId
        )
          reject("Canonical recovery identity or sequence gap");
      }
      const facts = await tx.query<RecoveryReceipt>(
        `SELECT r.sequence,r.observation_fingerprint,r.recovery_observation_json,r.event_ids_json,
        EXISTS(SELECT 1 FROM harness_reply_claims c WHERE c.turn_id=r.turn_id AND c.process_generation=r.process_generation AND c.request_sequence=r.sequence) AS consumed
        FROM harness_observation_receipts r WHERE r.turn_id=$1 AND r.process_generation=$2 AND r.recovery_observation_json IS NOT NULL ORDER BY r.sequence LIMIT 10001`,
        [this.selection.turnId, session.processGeneration],
      );
      if (facts.rows.length > 10000)
        reject("Ingress recovery exceeds bounded fact window");
      let terminal: Extract<
        HarnessObservation["payload"],
        { kind: "external_terminal" }
      > | null = null;
      let quiescence: HarnessQuiescence | null = null;
      const pendingRequests: PendingRequest[] = [];
      for (const fact of facts.rows) {
        const observation = HarnessObservationSchema.parse(
          json(fact.recovery_observation_json),
        );
        if (
          !sameSession(observation.session, session) ||
          observation.sequence !== Number(fact.sequence) ||
          observation.sequence > binding.lastObservationSequence ||
          (await fingerprintHarnessObservation(observation)) !==
            fact.observation_fingerprint
        )
          reject("Recovery ingress fingerprint or identity mismatch");
        const eventIds = json(fact.event_ids_json);
        if (
          !Array.isArray(eventIds) ||
          !eventIds.every(
            (id) =>
              typeof id === "string" &&
              lifecycleEvents.some((e) => e.eventId === id),
          )
        )
          reject("Recovery receipt canonical references missing");
        const payload = observation.payload;
        if (payload.kind === "external_terminal") terminal = payload;
        else if (payload.kind === "quiescence") {
          if (!sameSession(payload.evidence.session, session))
            reject("Quiescence recovery identity mismatch");
          quiescence = payload.evidence;
        } else if (
          payload.kind === "approval_requested" ||
          payload.kind === "user_input_requested"
        ) {
          this.checkRequest(observation, payload);
          const requested = lifecycleEvents.find(
            (event) =>
              eventIds.includes(event.eventId) &&
              requestMatches(payload, event),
          );
          if (!requested)
            reject("Private request handle lacks canonical request");
          const settled = lifecycleEvents.some(
            (event) =>
              event.sequence > requested.sequence &&
              requestSettled(payload, event),
          );
          if (!fact.consumed && !settled) pendingRequests.push(payload);
        } else reject("Unexpected retained recovery observation");
      }
      // Pending canonical requests without a durable private handle cannot safely reply.
      for (const event of lifecycleEvents) {
        if (
          event.type !== "approval.requested" &&
          event.type !== "user_input.requested"
        )
          continue;
        const resolved = lifecycleEvents.some(
          (later) =>
            later.sequence > event.sequence &&
            ((event.type === "approval.requested" &&
              later.type === "approval.decided" &&
              later.approvalId === event.approvalId) ||
              (event.type === "user_input.requested" &&
                (later.type === "user_input.responded" ||
                  later.type === "request.resolved") &&
                later.requestId === event.requestId)),
        );
        if (
          !resolved &&
          !facts.rows.some((f) => {
            const o = HarnessObservationSchema.parse(
              json(f.recovery_observation_json),
            );
            return (
              (o.payload.kind === "approval_requested" ||
                o.payload.kind === "user_input_requested") &&
              requestMatches(o.payload, event)
            );
          })
        )
          reject("Pending canonical request has no durable origin handle");
      }
      return {
        session,
        lifecycleEvents,
        lastSequence: binding.lastObservationSequence,
        externalTurnId: binding.externalTurnId,
        terminal,
        quiescence,
        pendingRequests,
      };
    });
  }
  async claimReply(
    value: HarnessRequestOrigin,
  ): Promise<"claimed" | "already_consumed"> {
    const origin = HarnessRequestOriginSchema.parse(value);
    try {
      return await this.client.transaction(async (tx) => {
        await turnLock(tx, this.selection.turnId);
        // Recheck inside the reservation transaction: the coordinator's earlier
        // assertActive can race terminal settlement while awaiting this lock.
        const admission = await tx.query(
          `SELECT a.turn_id FROM canonical_turn_admissions a JOIN sessions s ON s.id=a.session_id
          WHERE a.turn_id=$1 AND a.run_attempt_id=$2 AND a.session_id::text=$3 AND a.run_id=$4
          AND a.thread_id=$5 AND a.workspace_id=$6 AND s.user_id::text=$7
          AND a.admission_state='admitted' AND a.execution_state IN ('running','recovery_required')
          AND a.execution_claim_id IS NOT NULL FOR UPDATE OF a`,
          [
            this.selection.turnId,
            this.selection.runAttemptId,
            this.selection.sessionId,
            this.selection.runId,
            this.selection.threadId,
            this.selection.workspaceId,
            this.selection.userId,
          ],
        );
        if (!admission.rows[0])
          throw new HarnessPersistenceError(
            "stale_origin",
            "Reply requires an unsettled claimed admission",
          );
        await this.active(tx, origin.session);
        const selected = HarnessSelectionSchema.parse(
          JSON.parse(this.selection.selectionJson),
        );
        if (origin.authOwnerGeneration !== selected.authOwnerGeneration)
          reject("Reply auth-owner generation mismatch");
        const rows = await tx.query<RecoveryReceipt>(
          `SELECT sequence,observation_fingerprint,recovery_observation_json,event_ids_json FROM harness_observation_receipts WHERE turn_id=$1 AND process_generation=$2 AND recovery_observation_json IS NOT NULL ORDER BY sequence LIMIT 10001`,
          [this.selection.turnId, origin.session.processGeneration],
        );
        if (rows.rows.length > 10000)
          reject("Reply lookup exceeds bounded fact window");
        const matches = rows.rows.filter((row) => {
          const observation = HarnessObservationSchema.parse(
            json(row.recovery_observation_json),
          );
          return (
            (observation.payload.kind === "approval_requested" ||
              observation.payload.kind === "user_input_requested") &&
            createStableEventFingerprint(observation.payload.replyTo) ===
              createStableEventFingerprint(origin)
          );
        });
        if (matches.length !== 1)
          reject("Reply origin is unknown or ambiguous");
        const row = matches[0]!;
        const observation = HarnessObservationSchema.parse(
          json(row.recovery_observation_json),
        );
        if (
          (await fingerprintHarnessObservation(observation)) !==
          row.observation_fingerprint
        )
          reject("Reply request fingerprint mismatch");
        const payload = observation.payload;
        if (
          payload.kind !== "approval_requested" &&
          payload.kind !== "user_input_requested"
        )
          reject("Reply request is not actionable");
        this.checkRequest(observation, payload);
        const refs = json(row.event_ids_json);
        if (!Array.isArray(refs) || !refs.every((x) => typeof x === "string"))
          reject("Reply canonical references malformed");
        const canonical = await tx.query<{ event_json: unknown }>(
          "SELECT event_json FROM canonical_lifecycle_events WHERE turn_id=$1 AND run_attempt_id=$2 AND event_id=ANY($3::text[])",
          [this.selection.turnId, this.selection.runAttemptId, refs],
        );
        if (
          !canonical.rows.some((r) =>
            requestMatches(
              payload,
              LifecycleEventSchema.parse(json(r.event_json)),
            ),
          )
        )
          reject("Reply canonical request missing");
        const inserted = await tx.query(
          `INSERT INTO harness_reply_claims(turn_id,process_generation,request_sequence,origin_json)
        VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(turn_id,process_generation,request_sequence) DO NOTHING RETURNING request_sequence`,
          [
            this.selection.turnId,
            origin.session.processGeneration,
            Number(row.sequence),
            JSON.stringify(origin),
          ],
        );
        return inserted.rows.length ? "claimed" : "already_consumed";
      });
    } catch (error) {
      rethrowHarnessCommitFailure(error);
    }
  }
  private async input(
    observation: HarnessObservation,
  ): Promise<Omit<HarnessObservationCommit, "events">> {
    const selected = HarnessSelectionSchema.parse(
      JSON.parse(this.selection.selectionJson),
    );
    if (
      observation.session.runAttemptId !== this.selection.runAttemptId ||
      observation.session.instanceId !== selected.instanceId
    )
      reject("Observation is outside admitted attempt");
    return {
      selection: this.selection,
      origin: {
        instanceId: observation.session.instanceId,
        externalSessionId: observation.session.externalSessionId,
        processGeneration: observation.session.processGeneration,
        authOwnerGeneration: selected.authOwnerGeneration,
      },
      sequence: observation.sequence,
      observationFingerprint: await fingerprintHarnessObservation(observation),
      learnedExternalTurnId: observation.externalTurnId,
    };
  }
  private async active(tx: SqlClient, session: HarnessSession) {
    const binding = await new PostgresHarnessBindingRepository(tx).read(
      this.selection,
    );
    if (!binding) reject("Harness binding is missing");
    assertHarnessSelection(binding.selection, this.selection);
    const selected = HarnessSelectionSchema.parse(
      JSON.parse(this.selection.selectionJson),
    );
    if (session.runAttemptId !== this.selection.runAttemptId)
      reject("Recovery attempt mismatch");
    assertHarnessOrigin(binding.attachment, {
      instanceId: session.instanceId,
      externalSessionId: session.externalSessionId,
      processGeneration: session.processGeneration,
      authOwnerGeneration: selected.authOwnerGeneration,
    });
    return binding;
  }
  private checkRequest(
    observation: HarnessObservation,
    payload: PendingRequest,
  ): void {
    const selected = HarnessSelectionSchema.parse(
      JSON.parse(this.selection.selectionJson),
    );
    if (
      !sameSession(payload.replyTo.session, observation.session) ||
      payload.replyTo.authOwnerGeneration !== selected.authOwnerGeneration
    )
      reject("Private request origin mismatch");
  }
}
function requestMatches(
  payload: PendingRequest,
  event: LifecycleEvent,
): boolean {
  return payload.kind === "approval_requested"
    ? event.type === "approval.requested" &&
        event.approvalId === payload.request.approvalId
    : event.type === "user_input.requested" &&
        event.requestId === payload.requestId;
}
function requestSettled(
  payload: PendingRequest,
  event: LifecycleEvent,
): boolean {
  return payload.kind === "approval_requested"
    ? event.type === "approval.decided" &&
        event.approvalId === payload.request.approvalId
    : (event.type === "user_input.responded" ||
        event.type === "request.resolved") &&
        event.requestId === payload.requestId;
}
function sameSession(a: HarnessSession, b: HarnessSession): boolean {
  return createStableEventFingerprint(a) === createStableEventFingerprint(b);
}
function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}
async function turnLock(tx: SqlClient, turnId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    turnId,
  ]);
}
function reject(message: string): never {
  throw new HarnessPersistenceError("corrupt", message);
}
