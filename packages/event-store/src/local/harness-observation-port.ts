import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  HarnessSelectionSchema,
  userIdFromExternalId,
  workspaceIdFromExternalId,
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import {
  HarnessObservationSchema,
  HarnessRequestOriginSchema,
  HarnessSessionSchema,
  type HarnessSession,
  type HarnessObservation,
  type HarnessRequestOrigin,
  type HarnessQuiescence,
} from "@repo/worker-protocol";
import { createStableEventFingerprint } from "../fingerprint.js";
import {
  HarnessPersistenceError,
  StoredHarnessSelectionSchema,
  StoredHarnessAttachmentSchema,
  LocalHarnessBindingRepository,
  assertHarnessOrigin,
  assertHarnessSelection,
  harnessSelectionFingerprint,
  rethrowHarnessCommitFailure,
  type StoredHarnessSelection,
  type StoredHarnessBinding,
} from "./harness-bindings.js";
type Request = Extract<
  HarnessObservation["payload"],
  { kind: "approval_requested" | "user_input_requested" }
>;
type Fact = {
  sequence: number;
  observation_fingerprint: string;
  recovery_observation_json: string;
  event_ids_json: string;
  consumed: number;
};
/** Local implementation of P04's observation port. Uses LocalPersistence's
 * exclusively locked connection and canonical append callback only. */
export class LocalHarnessObservationCommitPort {
  private readonly selection: StoredHarnessSelection;
  private readonly repository: LocalHarnessBindingRepository;
  constructor(
    private readonly database: Database.Database,
    appendLifecycle: (event: LifecycleEvent) => LifecycleEvent,
    selection: StoredHarnessSelection,
  ) {
    this.selection = StoredHarnessSelectionSchema.parse(selection);
    this.repository = new LocalHarnessBindingRepository(
      database,
      appendLifecycle,
    );
    const binding = HarnessSelectionSchema.parse(
      JSON.parse(selection.selectionJson),
    );
    if (
      binding.userId !== userIdFromExternalId(selection.userId) ||
      binding.workspaceId !==
        workspaceIdFromExternalId(selection.workspaceId) ||
      binding.turnId !== selection.turnId ||
      binding.threadId !== selection.threadId ||
      binding.runAttemptId !== selection.runAttemptId ||
      binding.runId !== selection.runId
    )
      reject("Frozen runtime binding identity mismatch");
  }
  async lookup(value: HarnessObservation) {
    const observation = HarnessObservationSchema.parse(value);
    const ack = await this.repository.lookupObservation(
      this.input(observation),
    );
    return ack
      ? { session: observation.session, committedSequence: ack.sequence }
      : null;
  }
  async commit(input: {
    observation: HarnessObservation;
    events: readonly LifecycleEvent[];
  }) {
    const observation = HarnessObservationSchema.parse(input.observation);
    const storage = this.input(observation);
    const payload = observation.payload;
    if (
      payload.kind === "approval_requested" ||
      payload.kind === "user_input_requested"
    ) {
      this.checkRequest(observation, payload);
      if (
        !input.events.some((e) =>
          requestMatches(payload, LifecycleEventSchema.parse(e)),
        )
      )
        reject("Request ingress requires canonical request append");
    }
    if (
      payload.kind === "quiescence" &&
      !same(payload.evidence.session, observation.session)
    )
      reject("Quiescence session mismatch");
    try {
      return this.database
        .transaction(() => {
          const ack = this.repository.appendObservationWithin({
            ...storage,
            events: input.events,
          });
          if (
            [
              "approval_requested",
              "user_input_requested",
              "external_terminal",
              "quiescence",
            ].includes(payload.kind)
          ) {
            this.database
              .prepare(
                "UPDATE harness_observation_receipts SET recovery_observation_json=? WHERE turn_id=? AND process_generation=? AND sequence=? AND recovery_observation_json IS NULL",
              )
              .run(
                JSON.stringify(observation),
                this.selection.turnId,
                observation.session.processGeneration,
                observation.sequence,
              );
            const row = this.database
              .prepare(
                "SELECT recovery_observation_json FROM harness_observation_receipts WHERE turn_id=? AND process_generation=? AND sequence=?",
              )
              .get(
                this.selection.turnId,
                observation.session.processGeneration,
                observation.sequence,
              ) as { recovery_observation_json: string } | undefined;
            if (
              !row ||
              !same(JSON.parse(row.recovery_observation_json), observation)
            )
              reject("Recovery fact conflicts with ingress");
          }
          return {
            session: observation.session,
            committedSequence: ack.sequence,
          };
        })
        .immediate();
    } catch (error) {
      rethrowHarnessCommitFailure(error);
    }
  }
  async recover(value: HarnessSession) {
    const session = HarnessSessionSchema.parse(value);
    return this.database
      .transaction(() => {
        const binding = this.active(session);
        const summary = this.database
          .prepare(
            "SELECT count(*) AS count,min(sequence) AS first,max(sequence) AS last FROM harness_observation_receipts WHERE turn_id=? AND process_generation=?",
          )
          .get(this.selection.turnId, session.processGeneration) as {
          count: number;
          first: number | null;
          last: number | null;
        };
        if (
          summary.count !== binding.lastObservationSequence ||
          (summary.count > 0 &&
            (summary.first !== 1 ||
              summary.last !== binding.lastObservationSequence))
        )
          reject("Ingress coverage is incomplete");
        const rows = this.database
          .prepare(
            "SELECT event_json FROM events WHERE family='lifecycle' AND stream_id=? ORDER BY sequence LIMIT 10001",
          )
          .all(this.selection.turnId) as { event_json: string }[];
        if (rows.length > 10000)
          reject("Canonical recovery exceeds bounded replay window");
        const lifecycleEvents = rows.map((r) =>
          LifecycleEventSchema.parse(JSON.parse(r.event_json)),
        );
        for (let i = 0; i < lifecycleEvents.length; i++) {
          const e = lifecycleEvents[i]!;
          if (
            e.sequence !== i + 1 ||
            e.turnId !== this.selection.turnId ||
            e.threadId !== this.selection.threadId ||
            e.runAttemptId !== this.selection.runAttemptId
          )
            reject("Canonical recovery identity or sequence gap");
        }
        const facts = this.facts(session);
        let terminal: Extract<
          HarnessObservation["payload"],
          { kind: "external_terminal" }
        > | null = null;
        let quiescence: HarnessQuiescence | null = null;
        const pendingRequests: Request[] = [];
        for (const fact of facts) {
          const observation = this.fact(fact, session);
          if (observation.sequence > binding.lastObservationSequence)
            reject("Recovery sequence exceeds committed ingress");
          const refs = JSON.parse(fact.event_ids_json) as unknown;
          if (
            !Array.isArray(refs) ||
            !refs.every(
              (id) =>
                typeof id === "string" &&
                lifecycleEvents.some((e) => e.eventId === id),
            )
          )
            reject("Recovery canonical references missing");
          const p = observation.payload;
          if (p.kind === "external_terminal") terminal = p;
          else if (p.kind === "quiescence") {
            if (!same(p.evidence.session, session))
              reject("Recovery quiescence identity mismatch");
            quiescence = p.evidence;
          } else if (
            p.kind === "approval_requested" ||
            p.kind === "user_input_requested"
          ) {
            this.checkRequest(observation, p);
            const requested = lifecycleEvents.find(
              (e) => refs.includes(e.eventId) && requestMatches(p, e),
            );
            if (!requested) reject("Private origin lacks canonical request");
            if (
              !fact.consumed &&
              !lifecycleEvents.some(
                (e) => e.sequence > requested.sequence && settled(p, e),
              )
            )
              pendingRequests.push(p);
          } else reject("Unexpected recovery fact");
        }
        for (const e of lifecycleEvents) {
          if (
            e.type !== "approval.requested" &&
            e.type !== "user_input.requested"
          )
            continue;
          const resolved = lifecycleEvents.some(
            (l) =>
              l.sequence > e.sequence &&
              ((e.type === "approval.requested" &&
                l.type === "approval.decided" &&
                l.approvalId === e.approvalId) ||
                (e.type === "user_input.requested" &&
                  (l.type === "user_input.responded" ||
                    l.type === "request.resolved") &&
                  l.requestId === e.requestId)),
          );
          if (
            !resolved &&
            !facts.some((f) => {
              const p = HarnessObservationSchema.parse(
                JSON.parse(f.recovery_observation_json),
              ).payload;
              return (
                (p.kind === "approval_requested" ||
                  p.kind === "user_input_requested") &&
                requestMatches(p, e)
              );
            })
          )
            reject("Pending canonical request lacks durable origin");
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
      })
      .immediate();
  }
  async claimReply(
    value: HarnessRequestOrigin,
  ): Promise<"claimed" | "already_consumed"> {
    const origin = HarnessRequestOriginSchema.parse(value);
    try {
      return this.database
        .transaction(() => {
          this.active(origin.session);
          const selected = HarnessSelectionSchema.parse(
            JSON.parse(this.selection.selectionJson),
          );
          if (origin.authOwnerGeneration !== selected.authOwnerGeneration)
            reject("Reply auth-owner generation mismatch");
          const matches = this.facts(origin.session).filter((f) => {
            const o = this.fact(f, origin.session);
            return (
              (o.payload.kind === "approval_requested" ||
                o.payload.kind === "user_input_requested") &&
              same(o.payload.replyTo, origin)
            );
          });
          if (matches.length !== 1)
            reject("Reply origin is unknown or ambiguous");
          const row = matches[0]!;
          const o = this.fact(row, origin.session);
          const p = o.payload;
          if (
            p.kind !== "approval_requested" &&
            p.kind !== "user_input_requested"
          )
            reject("Reply request is not actionable");
          this.checkRequest(o, p);
          const refs = JSON.parse(row.event_ids_json) as unknown;
          if (!Array.isArray(refs) || !refs.every((x) => typeof x === "string"))
            reject("Reply references malformed");
          const found = refs.some((id) => {
            const e = this.database
              .prepare(
                "SELECT event_json FROM events WHERE family='lifecycle' AND stream_id=? AND event_id=?",
              )
              .get(this.selection.turnId, id) as
              | { event_json: string }
              | undefined;
            return (
              e &&
              requestMatches(
                p,
                LifecycleEventSchema.parse(JSON.parse(e.event_json)),
              )
            );
          });
          if (!found) reject("Reply canonical request missing");
          const result = this.database
            .prepare(
              "INSERT INTO harness_reply_claims(turn_id,process_generation,request_sequence,origin_json) VALUES(?,?,?,?) ON CONFLICT(turn_id,process_generation,request_sequence) DO NOTHING",
            )
            .run(
              this.selection.turnId,
              origin.session.processGeneration,
              row.sequence,
              JSON.stringify(origin),
            );
          return result.changes ? "claimed" : "already_consumed";
        })
        .immediate();
    } catch (error) {
      rethrowHarnessCommitFailure(error);
    }
  }
  private input(observation: HarnessObservation) {
    const selected = HarnessSelectionSchema.parse(
      JSON.parse(this.selection.selectionJson),
    );
    if (
      observation.session.runAttemptId !== this.selection.runAttemptId ||
      observation.session.instanceId !== selected.instanceId
    )
      reject("Observation outside admitted attempt");
    return {
      selection: this.selection,
      origin: {
        instanceId: observation.session.instanceId,
        externalSessionId: observation.session.externalSessionId,
        processGeneration: observation.session.processGeneration,
        authOwnerGeneration: selected.authOwnerGeneration,
      },
      sequence: observation.sequence,
      observationFingerprint: fingerprint(observation),
      learnedExternalTurnId: observation.externalTurnId,
    };
  }
  private active(session: HarnessSession): StoredHarnessBinding {
    const row = this.database
      .prepare(
        "SELECT * FROM harness_bindings WHERE turn_id=? AND run_attempt_id=? AND user_id=?",
      )
      .get(
        this.selection.turnId,
        this.selection.runAttemptId,
        this.selection.userId,
      ) as
      | {
          selection_json: string;
          selection_fingerprint: string;
          attachment_json: string | null;
          external_turn_id: string | null;
          last_observation_sequence: number;
        }
      | undefined;
    if (!row) reject("Harness binding missing");
    const selection = StoredHarnessSelectionSchema.parse(
      JSON.parse(row.selection_json),
    );
    if (harnessSelectionFingerprint(selection) !== row.selection_fingerprint)
      reject("Frozen binding fingerprint mismatch");
    assertHarnessSelection(selection, this.selection);
    const selected = HarnessSelectionSchema.parse(
      JSON.parse(selection.selectionJson),
    );
    const attachment = row.attachment_json
      ? StoredHarnessAttachmentSchema.parse(JSON.parse(row.attachment_json))
      : null;
    if (session.runAttemptId !== selection.runAttemptId)
      reject("Recovery attempt mismatch");
    assertHarnessOrigin(attachment, {
      instanceId: session.instanceId,
      externalSessionId: session.externalSessionId,
      processGeneration: session.processGeneration,
      authOwnerGeneration: selected.authOwnerGeneration,
    });
    return {
      selection,
      attachment,
      externalTurnId: row.external_turn_id,
      lastObservationSequence: row.last_observation_sequence,
    };
  }
  private facts(session: HarnessSession): Fact[] {
    const rows = this.database
      .prepare(
        "SELECT r.sequence,r.observation_fingerprint,r.recovery_observation_json,r.event_ids_json,EXISTS(SELECT 1 FROM harness_reply_claims c WHERE c.turn_id=r.turn_id AND c.process_generation=r.process_generation AND c.request_sequence=r.sequence) AS consumed FROM harness_observation_receipts r WHERE r.turn_id=? AND r.process_generation=? AND r.recovery_observation_json IS NOT NULL ORDER BY r.sequence LIMIT 10001",
      )
      .all(this.selection.turnId, session.processGeneration) as Fact[];
    if (rows.length > 10000) reject("Recovery facts exceed bounded window");
    return rows;
  }
  private fact(f: Fact, session: HarnessSession): HarnessObservation {
    const o = HarnessObservationSchema.parse(
      JSON.parse(f.recovery_observation_json),
    );
    if (
      !same(o.session, session) ||
      o.sequence !== f.sequence ||
      fingerprint(o) !== f.observation_fingerprint
    )
      reject("Recovery fact identity or fingerprint mismatch");
    return o;
  }
  private checkRequest(o: HarnessObservation, p: Request) {
    const selected = HarnessSelectionSchema.parse(
      JSON.parse(this.selection.selectionJson),
    );
    if (
      !same(p.replyTo.session, o.session) ||
      p.replyTo.authOwnerGeneration !== selected.authOwnerGeneration
    )
      reject("Private request origin mismatch");
  }
}
function fingerprint(value: unknown) {
  return createHash("sha256")
    .update(createStableEventFingerprint(value))
    .digest("hex");
}
function same(a: unknown, b: unknown) {
  return createStableEventFingerprint(a) === createStableEventFingerprint(b);
}
function requestMatches(p: Request, e: LifecycleEvent) {
  return p.kind === "approval_requested"
    ? e.type === "approval.requested" && e.approvalId === p.request.approvalId
    : e.type === "user_input.requested" && e.requestId === p.requestId;
}
function settled(p: Request, e: LifecycleEvent) {
  return p.kind === "approval_requested"
    ? e.type === "approval.decided" && e.approvalId === p.request.approvalId
    : (e.type === "user_input.responded" || e.type === "request.resolved") &&
        e.requestId === p.requestId;
}
function reject(message: string): never {
  throw new HarnessPersistenceError("corrupt", message);
}
