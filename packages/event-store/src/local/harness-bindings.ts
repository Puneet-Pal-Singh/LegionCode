import { HarnessOpeningIntentSchema, HarnessStartCommandSchema, fingerprintHarnessCommand,
  type HarnessOpeningIntent, type HarnessStartCommand } from "@repo/worker-protocol";
import type Database from "better-sqlite3";
import { ArtifactMetadataSchema, EventIdSchema, HarnessAdmissionSelectionSchema, HarnessSelectionSchema, PlatformEventSchema, TurnWorkspaceSnapshotSchema, type EventId } from "@repo/platform-protocol";
import type { LocalTurnAdmissions } from "../local-turn-admissions.js";
import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol/lifecycle";
import { z } from "zod";
import { EventStoreError, LocalPersistenceError } from "../errors.js";
import { createStableEventFingerprint } from "../fingerprint.js";

// Storage envelopes only. selectionJson is produced from the canonical P04
// selection schema; this layer never defines a second harness protocol.
const text = z.string().min(1).max(4096);
export const StoredHarnessSelectionSchema = z
  .object({
    userId: text,
    sessionId: text,
    runId: text,
    workspaceId: text,
    threadId: text,
    turnId: text,
    runAttemptId: text,
    selectionJson: z
      .string()
      .min(2)
      .max(65536)
      .refine((value) => {
        try {
          const parsed: unknown = JSON.parse(value);
          return (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          );
        } catch {
          return false;
        }
      }),
  })
  .strict();
export const StoredHarnessAttachmentSchema = z
  .object({
    instanceId: text,
    externalSessionId: text,
    processGeneration: z.string().uuid(),
    authOwnerGeneration: z.number().int().nonnegative().safe(),
  })
  .strict();
export type StoredHarnessSelection = z.infer<
  typeof StoredHarnessSelectionSchema
>;
export type StoredHarnessAttachment = z.infer<
  typeof StoredHarnessAttachmentSchema
>;
export interface StoredHarnessBinding {
  readonly selection: StoredHarnessSelection;
  readonly attachment: StoredHarnessAttachment | null;
  readonly externalTurnId: string | null;
  readonly lastObservationSequence: number;
}
export const StoredHarnessOpeningSchema = z.object({
  intent: HarnessOpeningIntentSchema,
  phase:z.enum(["reserved","dispatching","acknowledged","retired","cancelled_before_dispatch"]),
}).strict();
export type StoredHarnessOpening = z.infer<typeof StoredHarnessOpeningSchema>;
export interface ReserveHarnessOpeningInput {
  readonly selection:StoredHarnessSelection;
  readonly command:HarnessStartCommand;
  readonly intent:HarnessOpeningIntent;
}
export interface HarnessOpeningInput {
  readonly selection:StoredHarnessSelection;
  readonly intent:HarnessOpeningIntent;
}
export type HarnessOpeningReservation = {
  readonly status:"reserved"|"existing";readonly opening:StoredHarnessOpening;
};
export interface HarnessObservationCommit {
  readonly selection: StoredHarnessSelection;
  readonly origin: StoredHarnessAttachment;
  readonly sequence: number;
  /** SHA256 of the validated original observation, not a provider transcript. */
  readonly observationFingerprint: string;
  readonly events: readonly LifecycleEvent[];
  readonly learnedExternalTurnId?: string | null;
}
export interface HarnessObservationAck {
  readonly sequence: number;
  readonly eventIds: readonly string[];
  readonly duplicate: boolean;
}
export interface HarnessExecutionClaimResult {
  readonly status:
    | "claimed"
    | "already_claimed"
    | "recovery_required"
    | "settled";
  readonly binding: StoredHarnessBinding | null;
}
export interface HarnessBindingRepository {
  reserveOpening(input:ReserveHarnessOpeningInput):Promise<HarnessOpeningReservation>;
  beginOpeningDispatch(input:HarnessOpeningInput):Promise<void>;
  cancelReservedOpening(input:HarnessOpeningInput):Promise<"cancelled_before_dispatch"|"not_reserved">;
  acknowledgeOpening(input:HarnessOpeningInput & {readonly origin:StoredHarnessAttachment}):Promise<void>;
  readOpening(scope:Pick<StoredHarnessSelection,"userId"|"turnId"|"runAttemptId">):Promise<StoredHarnessOpening|null>;
  freezeAndClaim(input: {
    readonly selection: StoredHarnessSelection;
    readonly claimId: string;
    readonly events?: readonly LifecycleEvent[];
  }): Promise<HarnessExecutionClaimResult>;
  markRecoveryRequired(input: {
    readonly selection: StoredHarnessSelection;
    readonly claimId: string;
  }): Promise<boolean>;
  freeze(
    selection: StoredHarnessSelection,
    events?: readonly LifecycleEvent[],
  ): Promise<StoredHarnessBinding>;
  read(
    scope: Pick<StoredHarnessSelection, "userId" | "turnId" | "runAttemptId">,
  ): Promise<StoredHarnessBinding | null>;
  attach(input: {
    readonly selection: StoredHarnessSelection;
    readonly origin: StoredHarnessAttachment;
    readonly expectedProcessGeneration: string | null;
    readonly events?: readonly LifecycleEvent[];
  }): Promise<StoredHarnessBinding>;
  lookupObservation(
    input: Omit<HarnessObservationCommit, "events">,
  ): Promise<HarnessObservationAck | null>;
  appendObservation(
    input: HarnessObservationCommit,
  ): Promise<HarnessObservationAck>;
}
export class HarnessPersistenceError extends Error {
  constructor(
    readonly code:
      | "binding_conflict"
      | "stale_origin"
      | "sequence_gap"
      | "observation_conflict"
      | "admission_required"
      | "corrupt"
      | "commit_outcome_unknown",
    message: string,
  ) {
    super(message);
    this.name = "HarnessPersistenceError";
  }
}
export function harnessSelectionFingerprint(
  value: StoredHarnessSelection,
): string {
  const selection = StoredHarnessSelectionSchema.parse(value);
  return createStableEventFingerprint({
    ...selection,
    selectionJson: JSON.parse(selection.selectionJson) as unknown,
  });
}
export function assertHarnessSelection(
  saved: StoredHarnessSelection,
  requested: StoredHarnessSelection,
): void {
  if (
    harnessSelectionFingerprint(saved) !==
    harnessSelectionFingerprint(requested)
  ) {
    throw new HarnessPersistenceError(
      "binding_conflict",
      "Admitted harness selection is immutable",
    );
  }
}
export function assertHarnessOrigin(
  saved: StoredHarnessAttachment | null,
  requested: StoredHarnessAttachment,
): void {
  if (
    !saved ||
    createStableEventFingerprint(saved) !==
      createStableEventFingerprint(
        StoredHarnessAttachmentSchema.parse(requested),
      )
  ) {
    throw new HarnessPersistenceError(
      "stale_origin",
      "Harness observation origin is no longer active",
    );
  }
}
export function validateHarnessObservation(
  input: HarnessObservationCommit,
): void {
  StoredHarnessSelectionSchema.parse(input.selection);
  StoredHarnessAttachmentSchema.parse(input.origin);
  z.number().int().positive().safe().parse(input.sequence);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.observationFingerprint);
  if (
    input.learnedExternalTurnId !== undefined &&
    input.learnedExternalTurnId !== null
  )
    text.parse(input.learnedExternalTurnId);
  if (input.events.length > 1000)
    throw new HarnessPersistenceError(
      "observation_conflict",
      "Observation event batch exceeds its bound",
    );
  for (const value of input.events) {
    const event = LifecycleEventSchema.parse(value);
    if (
      event.threadId !== input.selection.threadId ||
      event.turnId !== input.selection.turnId ||
      event.runAttemptId !== input.selection.runAttemptId
    ) {
      throw new HarnessPersistenceError(
        "binding_conflict",
        "Observation event does not match its admitted attempt",
      );
    }
  }
}
export function assertHarnessAttachmentChange(
  binding: StoredHarnessBinding,
  origin: StoredHarnessAttachment,
  expected: string | null,
): void {
  StoredHarnessAttachmentSchema.parse(origin);
  const current = binding.attachment;
  if (
    (current?.processGeneration ?? null) !== expected ||
    (current && origin.processGeneration === current.processGeneration)
  ) {
    throw new HarnessPersistenceError(
      "stale_origin",
      "Harness attachment compare-and-swap failed",
    );
  }
  if (current && origin.authOwnerGeneration !== current.authOwnerGeneration) {
    throw new HarnessPersistenceError(
      "binding_conflict",
      "Credential ownership cannot change within an admitted attempt",
    );
  }
}

const LOCAL_SCHEMA = `
CREATE TABLE harness_bindings (
  turn_id TEXT PRIMARY KEY NOT NULL, run_attempt_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL, selection_json TEXT NOT NULL, selection_fingerprint TEXT NOT NULL,
  execution_claim_id TEXT, recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(recovery_required IN (0,1)),
  attachment_json TEXT, external_turn_id TEXT, last_observation_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_observation_sequence >= 0)
);
CREATE TABLE harness_process_generations (
  turn_id TEXT NOT NULL REFERENCES harness_bindings(turn_id) ON DELETE CASCADE,
  process_generation TEXT NOT NULL, origin_json TEXT NOT NULL,
  PRIMARY KEY(turn_id, process_generation)
);
CREATE TABLE harness_observation_receipts (
  turn_id TEXT NOT NULL REFERENCES harness_bindings(turn_id) ON DELETE CASCADE, process_generation TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0), observation_fingerprint TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  PRIMARY KEY(turn_id, process_generation, sequence)
);`;

/** Additive schema on the existing, already validated and exclusively locked writer. */
export function validateLocalHarnessBindings(
  database: Database.Database,
): boolean {
  const marker = database
    .prepare(
      "SELECT value FROM metadata WHERE key = 'harness_bindings_version'",
    )
    .get() as { value: string } | undefined;
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('harness_bindings','harness_process_generations','harness_observation_receipts')",
    )
    .all();
  if (!marker && tables.length === 0) return false;
  if (!["1", "2", "3"].includes(marker?.value ?? "") || tables.length !== 3)
    throw new LocalPersistenceError(
      "corrupt",
      "Local harness schema is incomplete",
    );
  for (const [name, key] of [
    ["harness_bindings", ["turn_id"]],
    ["harness_process_generations", ["turn_id", "process_generation"]],
    [
      "harness_observation_receipts",
      ["turn_id", "process_generation", "sequence"],
    ],
  ] as const) {
    const columns = database.pragma(`table_info(${name})`) as {
      name: string;
      pk: number;
    }[];
    const primary = columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    if (JSON.stringify(primary) !== JSON.stringify(key))
      throw new LocalPersistenceError(
        "corrupt",
        "Local harness primary key is invalid",
      );
  }
  const hasRecovery = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='harness_reply_claims'",
    )
    .get();
  const recoveryColumn = (
    database.pragma("table_info(harness_observation_receipts)") as {
      name: string;
    }[]
  ).some((c) => c.name === "recovery_observation_json");
  if (["2", "3"].includes(marker?.value ?? "") && (!hasRecovery || !recoveryColumn))
    throw new LocalPersistenceError(
      "corrupt",
      "Local harness recovery schema is incomplete",
    );
  if (marker?.value === "1" && (hasRecovery || recoveryColumn))
    throw new LocalPersistenceError(
      "corrupt",
      "Local harness recovery upgrade is incomplete",
    );
  if (["2", "3"].includes(marker?.value ?? "")) {
    const claimColumns = database.pragma(
      "table_info(harness_reply_claims)",
    ) as { name: string; pk: number }[];
    const keys = claimColumns
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    const refs = database.pragma("foreign_key_list(harness_reply_claims)") as {
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }[];
    if (
      JSON.stringify(keys) !==
        JSON.stringify(["turn_id", "process_generation", "request_sequence"]) ||
      !claimColumns.some((c) => c.name === "origin_json") ||
      refs.length !== 3 ||
      refs.some(
        (r) =>
          r.table !== "harness_observation_receipts" ||
          r.on_delete !== "CASCADE",
      ) ||
      !refs.some((r) => r.from === "request_sequence" && r.to === "sequence")
    )
      throw new LocalPersistenceError(
        "corrupt",
        "Local harness reply claim schema is invalid",
      );
  }

  const indexes = database.pragma("index_list(harness_bindings)") as {
    name: string;
    unique: number;
    partial: number;
  }[];
  if (
    !indexes.some((index) => {
      if (index.unique !== 1 || index.partial !== 0) return false;
      const name = index.name.replaceAll("'", "''");
      const columns = database.pragma(`index_info('${name}')`) as {
        name: string;
      }[];
      return columns.length === 1 && columns[0]?.name === "run_attempt_id";
    })
  )
    throw new LocalPersistenceError(
      "corrupt",
      "Local harness attempt uniqueness is missing",
    );
  const hasOpening = (database.pragma("table_info(harness_bindings)") as {name:string}[])
    .some(column=>column.name==="opening_json");
  if ((marker?.value === "3") !== hasOpening)
    throw new LocalPersistenceError("corrupt","Local harness opening schema version conflicts with its columns");
  const bindings = database
    .prepare(
      "SELECT turn_id,run_attempt_id,user_id,selection_json,selection_fingerprint,attachment_json,external_turn_id,execution_claim_id,recovery_required,last_observation_sequence FROM harness_bindings",
    )
    .all() as {
    turn_id: string;
    run_attempt_id: string;
    user_id: string;
    selection_json: string;
    selection_fingerprint: string;
    attachment_json: string | null;
    external_turn_id: string | null;
    execution_claim_id: string | null;
    recovery_required: number;
    last_observation_sequence: number;
  }[];
  for (const row of bindings) {
    const selection = StoredHarnessSelectionSchema.parse(
      JSON.parse(row.selection_json),
    );
    if (
      selection.turnId !== row.turn_id ||
      selection.runAttemptId !== row.run_attempt_id ||
      selection.userId !== row.user_id ||
      harnessSelectionFingerprint(selection) !== row.selection_fingerprint ||
      !Number.isSafeInteger(row.last_observation_sequence) ||
      row.last_observation_sequence < 0 ||
      ![0, 1].includes(row.recovery_required) ||
      (row.external_turn_id !== null && typeof row.external_turn_id !== "string") ||
      (row.execution_claim_id !== null && typeof row.execution_claim_id !== "string")
    )
      throw new LocalPersistenceError(
        "corrupt",
        "Local harness binding index is invalid",
      );
    if (row.attachment_json !== null)
      StoredHarnessAttachmentSchema.parse(JSON.parse(row.attachment_json));
    if(hasOpening){
      const extra=database.prepare("SELECT opening_json FROM harness_bindings WHERE turn_id=?").get(row.turn_id) as {opening_json:string|null};
      if(extra.opening_json!==null){
        const opening=StoredHarnessOpeningSchema.parse(JSON.parse(extra.opening_json));
        assertHarnessOpeningSelection(selection,opening.intent);
        if(!row.execution_claim_id ||
          ((opening.phase==="reserved" || opening.phase==="dispatching" || opening.phase==="cancelled_before_dispatch" || opening.phase==="retired") && row.attachment_json!==null) ||
          (opening.phase==="acknowledged" && row.attachment_json===null))
          throw new LocalPersistenceError("corrupt","Local opening phase conflicts with durable claim or origin");
        if(row.attachment_json!==null)assertHarnessOpeningOrigin(opening,StoredHarnessAttachmentSchema.parse(JSON.parse(row.attachment_json)));
      }
    }
  }
  return true;
}

export function initializeLocalHarnessBindings(
  database: Database.Database,
): void {
  const existing = validateLocalHarnessBindings(database);
  const marker = database
    .prepare("SELECT value FROM metadata WHERE key='harness_bindings_version'")
    .get() as { value: string } | undefined;
  if (existing && marker?.value === "3") return;
  database
    .transaction(() => {
      if (!existing) database.exec(LOCAL_SCHEMA);
      if (!existing || marker?.value === "1") {
      database.exec(
        "ALTER TABLE harness_observation_receipts ADD COLUMN recovery_observation_json TEXT",
      );
      database.exec(
        "CREATE TABLE harness_reply_claims(turn_id TEXT NOT NULL,process_generation TEXT NOT NULL,request_sequence INTEGER NOT NULL,origin_json TEXT NOT NULL,PRIMARY KEY(turn_id,process_generation,request_sequence),FOREIGN KEY(turn_id,process_generation,request_sequence) REFERENCES harness_observation_receipts(turn_id,process_generation,sequence) ON DELETE CASCADE)",
      );
      }
      database.exec("ALTER TABLE harness_bindings ADD COLUMN opening_json TEXT");
      database
        .prepare(
          "INSERT INTO metadata(key,value) VALUES ('harness_bindings_version','3') ON CONFLICT(key) DO UPDATE SET value='3'",
        )
        .run();
    })
    .immediate();
}

export class LocalHarnessBindingRepository implements HarnessBindingRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly appendLifecycle: (event: LifecycleEvent) => LifecycleEvent,
    private readonly admissions?: Pick<LocalTurnAdmissions, "getByTurn">,
  ) {}

  async reserveOpening(input:ReserveHarnessOpeningInput):Promise<HarnessOpeningReservation> {
    const {selection,intent,command}=await validateHarnessOpeningCommand(input);
    if(intent.executionLease.kind!=="local" || intent.executionLease.leaseId!==command.leaseId)
      throw new HarnessPersistenceError("binding_conflict","Local opening requires its actual local command lease");
    return this.database.transaction(()=>{
      this.requireAdmission(selection);this.requireClaim(selection.turnId);
      const binding=this.required(selection);
      const prior=this.readOpeningWithin(selection);
      if (prior) { assertHarnessOpeningIntent(prior,intent);return {status:"existing" as const,opening:prior}; }
      const flags=this.database.prepare("SELECT recovery_required FROM harness_bindings WHERE turn_id=?")
        .get(selection.turnId) as {recovery_required:number};
      if (binding.attachment || this.isSettled(selection.turnId) || flags.recovery_required !== 0)
        throw new HarnessPersistenceError("stale_origin","Opening requires a fresh claimed attempt");
      const admission=this.admissions?.getByTurn(selection.turnId);
      if (!admission) throw new HarnessPersistenceError("admission_required","Opening admission is missing");
      const rows=this.database.prepare("SELECT event_json,event_id,thread_id,turn_id,stream_type,stream_id,sequence,cursor,idempotency_key,fingerprint FROM events WHERE family='lifecycle' AND (stream_id=? OR turn_id=?) ORDER BY sequence LIMIT 10001")
        .all(selection.turnId,selection.turnId) as {event_json:string;event_id:string;thread_id:string;turn_id:string;stream_type:string;stream_id:string;sequence:number;cursor:string|null;idempotency_key:string;fingerprint:string}[];
      const history=rows.map(row=>{
        const event=LifecycleEventSchema.parse(JSON.parse(row.event_json));
        if(row.event_id!==event.eventId || row.thread_id!==event.threadId || row.turn_id!==event.turnId ||
          row.stream_type!=="turn" || row.stream_id!==event.turnId || row.sequence!==event.sequence ||
          row.cursor!==null || row.idempotency_key!==event.idempotencyKey || row.fingerprint!==createStableEventFingerprint(event))
          throw new HarnessPersistenceError("corrupt","Opening lifecycle indices conflict with canonical events");
        return event;
      });
      validateHarnessOpeningHistory(selection,command,history,admission.run.workerId);
      const opening:StoredHarnessOpening={intent,phase:"reserved"};
      const changed=this.database.prepare("UPDATE harness_bindings SET opening_json=? WHERE turn_id=? AND run_attempt_id=? AND user_id=? AND opening_json IS NULL AND attachment_json IS NULL")
        .run(JSON.stringify(opening),selection.turnId,selection.runAttemptId,selection.userId);
      if(changed.changes!==1)throw new HarnessPersistenceError("stale_origin","Opening reservation lost canonical ownership");
      return {status:"reserved" as const,opening};
    }).immediate();
  }
  async beginOpeningDispatch(raw:HarnessOpeningInput):Promise<void> {
    const input={selection:StoredHarnessSelectionSchema.parse(raw.selection),
      intent:HarnessOpeningIntentSchema.parse(raw.intent)};
    this.database.transaction(()=>{
      this.requireAdmission(input.selection);this.requireClaim(input.selection.turnId);this.required(input.selection);
      const opening=this.readOpeningWithin(input.selection);
      if(!opening)throw new HarnessPersistenceError("stale_origin","Opening reservation is missing");
      assertHarnessOpeningIntent(opening,input.intent);
      const row=this.database.prepare("SELECT recovery_required FROM harness_bindings WHERE turn_id=?").get(input.selection.turnId) as {recovery_required:number};
      if(opening.phase!=="reserved" || this.isSettled(input.selection.turnId) || row.recovery_required!==0)
        throw new HarnessPersistenceError("stale_origin","Opening dispatch cannot be repeated or recovered by resend");
      this.database.prepare("UPDATE harness_bindings SET opening_json=? WHERE turn_id=?")
        .run(JSON.stringify({...opening,phase:"dispatching"}),input.selection.turnId);
    }).immediate();
  }
  async cancelReservedOpening(raw:HarnessOpeningInput):Promise<"cancelled_before_dispatch"|"not_reserved"> {
    const input={selection:StoredHarnessSelectionSchema.parse(raw.selection),
      intent:HarnessOpeningIntentSchema.parse(raw.intent)};
    return this.database.transaction(()=>{
      this.requireAdmission(input.selection);this.requireClaim(input.selection.turnId);this.required(input.selection);
      const opening=this.readOpeningWithin(input.selection);
      if(!opening)throw new HarnessPersistenceError("stale_origin","Opening reservation is missing");
      assertHarnessOpeningIntent(opening,input.intent);
      if(opening.phase==="cancelled_before_dispatch")return "cancelled_before_dispatch" as const;
      if(opening.phase!=="reserved")return "not_reserved" as const;
      // Same immediate writer as beginOpeningDispatch; no physical proof is inferred.
      this.database.prepare("UPDATE harness_bindings SET opening_json=? WHERE turn_id=?")
        .run(JSON.stringify({...opening,phase:"cancelled_before_dispatch"}),input.selection.turnId);
      return "cancelled_before_dispatch" as const;
    }).immediate();
  }
  async acknowledgeOpening(raw:HarnessOpeningInput & {readonly origin:StoredHarnessAttachment}):Promise<void> {
    const input={selection:StoredHarnessSelectionSchema.parse(raw.selection),
      intent:HarnessOpeningIntentSchema.parse(raw.intent),origin:StoredHarnessAttachmentSchema.parse(raw.origin)};
    this.database.transaction(()=>{
      this.requireAdmission(input.selection);this.requireClaim(input.selection.turnId);const binding=this.required(input.selection);
      const opening=this.readOpeningWithin(input.selection);
      if(!opening)throw new HarnessPersistenceError("stale_origin","Opening reservation is missing");
      assertHarnessOpeningIntent(opening,input.intent);assertHarnessOpeningOrigin(opening,input.origin);
      if(opening.phase==="acknowledged" && sameHarnessOrigin(binding.attachment,input.origin))return;
      if(opening.phase!=="dispatching" || binding.attachment)
        throw new HarnessPersistenceError("stale_origin","Native acknowledgement conflicts with opening phase");
      // A late native ACK is a cleanup fact, even after terminal settlement.
      // It grants no prompt permission and can only fill the committed opening.
      if(binding.lastObservationSequence!==0)
        throw new HarnessPersistenceError("sequence_gap","Unacknowledged opening already has committed ingress");
      const known=this.database.prepare("SELECT origin_json FROM harness_process_generations WHERE turn_id=? AND process_generation=?")
        .get(input.selection.turnId,input.origin.processGeneration);
      if(known)throw new HarnessPersistenceError("stale_origin","Opening generation was already recorded");
      this.database.prepare("INSERT INTO harness_process_generations(turn_id,process_generation,origin_json) VALUES (?,?,?)")
        .run(input.selection.turnId,input.origin.processGeneration,JSON.stringify(StoredHarnessAttachmentSchema.parse(input.origin)));
      this.database.prepare("UPDATE harness_bindings SET attachment_json=? WHERE turn_id=? AND attachment_json IS NULL")
        .run(JSON.stringify(input.origin),input.selection.turnId);
      this.database.prepare("UPDATE harness_bindings SET opening_json=? WHERE turn_id=?")
        .run(JSON.stringify({...opening,phase:"acknowledged"}),input.selection.turnId);
    }).immediate();
  }
  async readOpening(raw:Pick<StoredHarnessSelection,"userId"|"turnId"|"runAttemptId">):Promise<StoredHarnessOpening|null> {
    const scope=StoredHarnessSelectionSchema.pick({userId:true,turnId:true,runAttemptId:true}).parse(raw);
    return this.database.transaction(()=>this.readOpeningWithin(scope))();
  }
  private readOpeningWithin(scope:Pick<StoredHarnessSelection,"userId"|"turnId"|"runAttemptId">):StoredHarnessOpening|null {
    const binding=this.readWithin(scope);if(!binding)return null;
    this.requireAdmission(binding.selection);
    const row=this.database.prepare("SELECT opening_json FROM harness_bindings WHERE turn_id=? AND run_attempt_id=? AND user_id=?")
      .get(scope.turnId,scope.runAttemptId,scope.userId) as {opening_json:string|null}|undefined;
    if(!row)throw new HarnessPersistenceError("corrupt","Opening binding disappeared in its transaction");
    if(row.opening_json===null)return null;
    const opening=StoredHarnessOpeningSchema.parse(JSON.parse(row.opening_json));
    assertHarnessOpeningSelection(binding.selection,opening.intent);
    return opening;
  }
  async freeze(
    value: StoredHarnessSelection,
    events: readonly LifecycleEvent[] = [],
  ): Promise<StoredHarnessBinding> {
    return this.database
      .transaction(() => this.freezeWithin(value, events))
      .immediate();
  }
  private freezeWithin(
    value: StoredHarnessSelection,
    events: readonly LifecycleEvent[],
  ): StoredHarnessBinding {
    const selection = StoredHarnessSelectionSchema.parse(value);
    this.requireAdmission(selection);
    for (const event of events) {
      assertEventScope(selection, event);
      this.appendLifecycle(event);
    }
    const existing = this.readWithin(selection);
    if (existing) {
      assertHarnessSelection(existing.selection, selection);
      return existing;
    }
    this.database
      .prepare(
        "INSERT INTO harness_bindings(turn_id,run_attempt_id,user_id,selection_json,selection_fingerprint) VALUES (?,?,?,?,?)",
      )
      .run(
        selection.turnId,
        selection.runAttemptId,
        selection.userId,
        JSON.stringify(selection),
        harnessSelectionFingerprint(selection),
      );
    return {
      selection,
      attachment: null,
      externalTurnId: null,
      lastObservationSequence: 0,
    };
  }
  private requireAdmission(selection: StoredHarnessSelection): void {
    // This read reconstructs the existing admission and verifies its canonical
    // event references and request fingerprint on the same SQLite connection.
    // Admission precedes credential acquisition and kernel lifecycle start.
    const admission = this.admissions?.getByTurn(selection.turnId);
    if (!admission || admission.userMessage.type !== "user_message")
      throw new HarnessPersistenceError(
        "admission_required",
        "Harness binding requires canonical local admission",
      );
    const binding = HarnessSelectionSchema.parse(JSON.parse(selection.selectionJson));
    const capture = HarnessAdmissionSelectionSchema.parse("harnessSelection" in admission.run ? admission.run.harnessSelection : undefined);
    const contentCapture = HarnessAdmissionSelectionSchema.parse(admission.userMessage.content.harnessSelection);
    const chosen = capture.selection;
    const environment = this.database
      .prepare("SELECT value FROM metadata WHERE key='local_environment_id_v1'")
      .get() as { value: string } | undefined;
    if (
      !chosen || !environment ||
      createStableEventFingerprint(capture) !== createStableEventFingerprint(contentCapture) ||
      selection.sessionId !== selection.threadId ||
      admission.run.id !== selection.runId ||
      admission.run.userId !== selection.userId ||
      admission.run.workspaceId !== selection.workspaceId ||
      admission.run.threadId !== selection.threadId ||
      admission.turn.id !== selection.turnId ||
      admission.turn.runId !== selection.runId ||
      admission.turn.threadId !== selection.threadId ||
      admission.runAttemptId !== selection.runAttemptId ||
      binding.userId !== selection.userId ||
      binding.workspaceId !== selection.workspaceId ||
      binding.threadId !== selection.threadId ||
      binding.runId !== selection.runId ||
      binding.turnId !== selection.turnId ||
      binding.runAttemptId !== selection.runAttemptId ||
      binding.environmentId !== environment.value ||
      binding.environmentId !== capture.environmentId ||
      binding.selectionRevision !== capture.selectionRevision ||
      binding.harness !== chosen.harness ||
      binding.instanceId !== chosen.instanceId ||
      binding.connectionId !== chosen.connectionId ||
      binding.modelId !== chosen.modelId ||
      binding.modelId !== admission.run.modelId ||
      binding.policyId !== admission.run.permissionProfileId
    )
      throw new HarnessPersistenceError(
        "binding_conflict",
        "Harness binding differs from canonical local admission capture",
      );
  }
  async freezeAndClaim(input: {
    selection: StoredHarnessSelection;
    claimId: string;
    events?: readonly LifecycleEvent[];
  }): Promise<HarnessExecutionClaimResult> {
    text.parse(input.claimId);
    return this.database
      .transaction(() => {
        const binding = this.freezeWithin(input.selection, input.events ?? []);
        const state = this.database
          .prepare(
            "SELECT execution_claim_id,recovery_required FROM harness_bindings WHERE turn_id=?",
          )
          .get(input.selection.turnId) as {
          execution_claim_id: string | null;
          recovery_required: number;
        };
        // Terminal lifecycle does not retire a still-owned physical generation.
        const opening=this.readOpeningWithin(input.selection);
        if (state.recovery_required === 1 && (binding.attachment !== null || (opening !== null && opening.phase!=="retired")))
          return { status: "recovery_required" as const, binding };
        if (this.isSettled(input.selection.turnId))
          return { status: "settled" as const, binding };
        if (state.recovery_required === 1)
          return { status: "recovery_required" as const, binding };
        if (state.execution_claim_id !== null)
          return { status: "already_claimed" as const, binding };
        this.database
          .prepare(
            "UPDATE harness_bindings SET execution_claim_id=? WHERE turn_id=?",
          )
          .run(input.claimId, input.selection.turnId);
        return { status: "claimed" as const, binding };
      })
      .immediate();
  }
  async markRecoveryRequired(input: {
    selection: StoredHarnessSelection;
    claimId: string;
  }): Promise<boolean> {
    return this.database
      .transaction(() => {
        const binding = this.required(input.selection);
        // A terminal turn can still own a physical generation when CORE release
        // committed its journal marker but SQLite retirement did not commit.
        const opening=this.readOpeningWithin(input.selection);
        if (this.isSettled(input.selection.turnId) && !binding.attachment && (!opening || opening.phase==="retired")) return false;
        return (
          this.database
            .prepare(
              "UPDATE harness_bindings SET recovery_required=1 WHERE turn_id=? AND execution_claim_id=? AND recovery_required=0",
            )
            .run(input.selection.turnId, input.claimId).changes === 1
        );
      })
      .immediate();
  }
  /** Private LOCAL composition calls only AFTER CORE release succeeds. Storage
   * validates canonical facts; it does not certify physical quiescence or release
   * the checkout. An absent tombstone always leaves the attachment owned. */
  async retireHarnessAttachment(input: {
    selection: StoredHarnessSelection;
    origin: StoredHarnessAttachment;
    lastObservationSequence: number;
    terminalEventId: EventId;
  }): Promise<void> {
    const selection = StoredHarnessSelectionSchema.parse(input.selection);
    const origin = StoredHarnessAttachmentSchema.parse(input.origin);
    const sequence = z.number().int().nonnegative().safe().parse(input.lastObservationSequence);
    const terminalEventId = EventIdSchema.parse(input.terminalEventId);
    this.database.transaction(() => {
      this.requireAdmission(selection);
      const binding = this.required(selection);
      this.requireClaim(selection.turnId);
      if (binding.lastObservationSequence !== sequence)
        throw new HarnessPersistenceError("sequence_gap", "Retirement does not cover committed ingress");
      const tombstone = this.retirementEvidence(selection, origin, sequence, terminalEventId);
      const key = `harness_attachment_retirement_v1:${selection.turnId}:${origin.processGeneration}`;
      const prior = this.database.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined;
      if (prior) {
        if (binding.attachment || createStableEventFingerprint(JSON.parse(prior.value)) !== createStableEventFingerprint(tombstone))
          throw new HarnessPersistenceError("stale_origin", "Retirement tombstone conflicts with attachment or evidence");
        return;
      }
      assertHarnessOrigin(binding.attachment, origin);
      this.database.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(key, JSON.stringify(tombstone));
      const retired = this.database.prepare(
        "UPDATE harness_bindings SET attachment_json=NULL,recovery_required=0 WHERE turn_id=? AND run_attempt_id=? AND user_id=? AND json_extract(attachment_json,'$.processGeneration')=?",
      ).run(selection.turnId, selection.runAttemptId, selection.userId, origin.processGeneration);
      if (retired.changes !== 1)
        throw new HarnessPersistenceError("stale_origin", "Retirement attachment compare-and-swap failed");
      const opening=this.readOpeningWithin(selection);
      if(opening){
        assertHarnessOpeningOrigin(opening,origin);
        if(opening.phase!=="acknowledged")throw new HarnessPersistenceError("stale_origin","Retirement opening is unresolved");
        this.database.prepare("UPDATE harness_bindings SET opening_json=? WHERE turn_id=?")
          .run(JSON.stringify({...opening,phase:"retired"}),selection.turnId);
      }
      // Keep generation origins, canonical events and every ingress/reply receipt.
    }).immediate();
  }
  /** Read-only evidence reconstruction shared with the canonical retirement writer.
   * The caller owns the transaction; this never releases CORE or changes storage.
   */
  private retirementEvidence(
    selection: StoredHarnessSelection,
    origin: StoredHarnessAttachment,
    sequence: number,
    terminalEventId: EventId,
  ) {
    const admission = this.admissions?.getByTurn(selection.turnId);
    if (!admission)
      throw new HarnessPersistenceError("admission_required", "Retirement requires its canonical admitted producer");
    const selected = HarnessSelectionSchema.parse(JSON.parse(selection.selectionJson));
    if (origin.instanceId !== selected.instanceId || origin.authOwnerGeneration !== selected.authOwnerGeneration)
      throw new HarnessPersistenceError("stale_origin", "Retirement origin differs from admitted instance or account generation");
    const generation = this.database.prepare(
      "SELECT origin_json FROM harness_process_generations WHERE turn_id=? AND process_generation=?",
    ).get(selection.turnId, origin.processGeneration) as { origin_json: string } | undefined;
    if (!generation || !sameHarnessOrigin(StoredHarnessAttachmentSchema.parse(JSON.parse(generation.origin_json)), origin))
      throw new HarnessPersistenceError("stale_origin", "Retirement generation history does not match");
    const historyRows = this.database.prepare(
      "SELECT event_json,event_id,thread_id,turn_id,stream_type,stream_id,sequence,cursor,idempotency_key,fingerprint FROM events WHERE family='lifecycle' AND (stream_id=? OR turn_id=?) ORDER BY sequence LIMIT 10001",
    ).all(selection.turnId, selection.turnId) as {
      event_json: string; event_id: string; thread_id: string; turn_id: string | null;
      stream_type: string; stream_id: string; sequence: number; cursor: string | null;
      idempotency_key: string; fingerprint: string;
    }[];
    if (historyRows.length > 10000)
      throw new HarnessPersistenceError("corrupt", "Retirement exceeds bounded canonical replay");
    const history = historyRows.map((row, index) => {
      const event = LifecycleEventSchema.parse(JSON.parse(row.event_json));
      assertEventScope(selection, event);
      if (event.producer.id !== admission.run.workerId)
        throw new HarnessPersistenceError("binding_conflict", "Retirement lifecycle producer differs from canonical admission");
      if (row.event_id !== event.eventId || row.thread_id !== event.threadId ||
          row.turn_id !== event.turnId || row.stream_type !== "turn" || row.stream_id !== event.turnId ||
          row.sequence !== event.sequence || row.cursor !== null ||
          row.idempotency_key !== event.idempotencyKey || row.fingerprint !== createStableEventFingerprint(event))
        throw new HarnessPersistenceError("corrupt", "Retirement lifecycle index conflicts with canonical evidence");
      if (event.sequence !== index + 1)
        throw new HarnessPersistenceError("corrupt", "Retirement canonical replay has a gap");
      return event;
    });
    const terminal = history.at(-1);
    if (!terminal || terminal.eventId !== terminalEventId ||
        !["turn.completed", "turn.failed", "turn.interrupted"].includes(terminal.type))
      throw new HarnessPersistenceError("binding_conflict", "Retirement requires the final canonical terminal event");
    const receipts = this.database.prepare(
      "SELECT sequence,event_ids_json FROM harness_observation_receipts WHERE turn_id=? AND process_generation=? ORDER BY sequence LIMIT 10001",
    ).all(selection.turnId, origin.processGeneration) as { sequence: number; event_ids_json: string }[];
    if (receipts.length > 10000 || receipts.length !== sequence)
      throw new HarnessPersistenceError("sequence_gap", "Retirement ingress coverage is incomplete or exceeds its bound");
    for (const [index, receipt] of receipts.entries()) {
      if (receipt.sequence !== index + 1)
        throw new HarnessPersistenceError("sequence_gap", "Retirement ingress coverage has a gap");
      this.validateCanonicalReferences(selection, receipt.event_ids_json);
    }
    // Match the immutable metadata in runtime settlement to the existing
    // platform artifact records. No filesystem or provider-history authority.
    const artifactReferences: string[] = [];
    let snapshot = false;
    let diff = false;
    for (const event of history) {
      let candidate: unknown;
      let role: "snapshot" | "diff";
      if (event.type === "workspace.snapshot_captured") {
        const wrapper = z.object({ snapshot: TurnWorkspaceSnapshotSchema, artifact: z.unknown().optional() })
          .parse(event.payload.snapshot);
        if (wrapper.snapshot.phase !== "terminal") continue;
        if (wrapper.snapshot.turnId !== selection.turnId)
          throw new HarnessPersistenceError("binding_conflict", "Retirement snapshot belongs to another turn");
        candidate = wrapper.artifact;
        role = "snapshot";
      } else if (event.type === "artifact.created") {
        const parsed = ArtifactMetadataSchema.safeParse(event.payload.artifact);
        if (!parsed.success || parsed.data.metadata.role !== "turn_diff") continue;
        candidate = parsed.data;
        role = "diff";
      } else continue;
      const artifact = ArtifactMetadataSchema.parse(candidate);
      if (artifact.threadId !== selection.threadId || artifact.runId !== selection.runId ||
          artifact.workspaceId !== selection.workspaceId || artifact.metadata.turnId !== selection.turnId ||
          artifact.metadata.createdBy !== selection.userId || artifact.payloadRef.backend !== "local_blob" ||
          !artifact.payloadRef.sha256 || artifact.payloadRef.objectKey !== `sha256:${artifact.payloadRef.sha256}` ||
          (role === "snapshot" && (artifact.kind !== "workspace_snapshot" || artifact.metadata.phase !== "snapshot:terminal")) ||
          (role === "diff" && artifact.kind !== "diff"))
        throw new HarnessPersistenceError("binding_conflict", "Retirement immutable artifact ownership is invalid");
      const row = this.database.prepare(
        "SELECT event_json FROM events WHERE family='platform' AND stream_type='artifact' AND stream_id=? AND sequence=1",
      ).get(artifact.artifactId) as { event_json: string } | undefined;
      const persisted = row ? PlatformEventSchema.parse(JSON.parse(row.event_json)) : null;
      if (!persisted || persisted.type !== "artifact.created" ||
          persisted.threadId !== selection.threadId || persisted.workspaceId !== selection.workspaceId ||
          persisted.runId !== selection.runId ||
          createStableEventFingerprint(persisted.payload.artifact) !== createStableEventFingerprint(artifact))
        throw new HarnessPersistenceError("corrupt", "Retirement immutable artifact reference is missing or conflicting");
      artifactReferences.push(persisted.eventId);
      if (role === "snapshot") snapshot = true;
      else diff = true;
    }
    if (!snapshot || !diff)
      throw new HarnessPersistenceError("binding_conflict", "Retirement requires committed terminal snapshot and diff");
    return { version: 1 as const, selectionFingerprint: harnessSelectionFingerprint(selection), origin,
      lastObservationSequence: sequence, terminalEventId, artifactReferences: artifactReferences.sort() };
  }

  /** Positive restart receipt from the existing retirement transaction only.
   * A missing attachment, terminal event or execution claim alone is no proof.
   */
  async readAttachmentRetirement(
    scope: Pick<StoredHarnessSelection, "userId" | "turnId" | "runAttemptId">,
  ): Promise<
    | { readonly status: "verified_retirement"; readonly selection: StoredHarnessSelection;
        readonly retirements: readonly {
          readonly origin: StoredHarnessAttachment; readonly lastObservationSequence: number;
          readonly terminalEventId: EventId; readonly artifactReferences: readonly EventId[];
        }[] }
    | { readonly status: "owned_or_unknown" }
  > {
    text.parse(scope.userId); text.parse(scope.turnId); text.parse(scope.runAttemptId);
    return this.database.transaction(() => {
      const unknown = { status: "owned_or_unknown" as const };
      const binding = this.readWithin(scope);
      if (!binding) return unknown;
      this.requireAdmission(binding.selection);
      const state = this.database.prepare(
        "SELECT execution_claim_id,recovery_required,selection_fingerprint FROM harness_bindings WHERE turn_id=? AND run_attempt_id=? AND user_id=?",
      ).get(scope.turnId, scope.runAttemptId, scope.userId) as {
        execution_claim_id: string | null; recovery_required: number; selection_fingerprint: string;
      } | undefined;
      if (!state)
        throw new HarnessPersistenceError("corrupt", "Retirement binding disappeared within its read transaction");
      if (state.execution_claim_id !== null) text.parse(state.execution_claim_id);
      if (binding.selection.userId !== scope.userId || binding.selection.turnId !== scope.turnId ||
          binding.selection.runAttemptId !== scope.runAttemptId ||
          harnessSelectionFingerprint(binding.selection) !== state.selection_fingerprint ||
          ![0, 1].includes(state.recovery_required) ||
          !Number.isSafeInteger(binding.lastObservationSequence) || binding.lastObservationSequence < 0)
        throw new HarnessPersistenceError("corrupt", "Retirement binding index conflicts with its immutable selection");
      if (binding.attachment || !state.execution_claim_id || state.recovery_required !== 0) return unknown;
      const opening=this.readOpeningWithin(scope);
      if(opening && opening.phase!=="retired")return unknown;
      this.requireClaim(scope.turnId);
      const generations = this.database.prepare(
        "SELECT process_generation,origin_json FROM harness_process_generations WHERE turn_id=? ORDER BY process_generation LIMIT 129",
      ).all(scope.turnId) as { process_generation: string; origin_json: string }[];
      if (generations.length > 128)
        throw new HarnessPersistenceError("corrupt", "Retirement generation history exceeds its bound");
      if (generations.length === 0) return unknown;
      const schema = z.object({
        version: z.literal(1), selectionFingerprint: text, origin: StoredHarnessAttachmentSchema,
        lastObservationSequence: z.number().int().nonnegative().safe(), terminalEventId: EventIdSchema,
        artifactReferences: z.array(EventIdSchema).max(10000),
      }).strict();
      const retirements = [];
      let coversCurrentWatermark = false;
      for (const generation of generations) {
        const origin = StoredHarnessAttachmentSchema.parse(JSON.parse(generation.origin_json));
        if (origin.processGeneration !== generation.process_generation)
          throw new HarnessPersistenceError("corrupt", "Retirement generation key conflicts with origin");
        const key = `harness_attachment_retirement_v1:${scope.turnId}:${origin.processGeneration}`;
        const row = this.database.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined;
        if (!row) return unknown;
        const stored = schema.parse(JSON.parse(row.value));
        if (!sameHarnessOrigin(stored.origin, origin))
          throw new HarnessPersistenceError("stale_origin", "Retirement receipt belongs to another generation");
        const expected = this.retirementEvidence(binding.selection, origin,
          stored.lastObservationSequence, stored.terminalEventId);
        if (createStableEventFingerprint(stored) !== createStableEventFingerprint(expected))
          throw new HarnessPersistenceError("corrupt", "Retirement receipt conflicts with canonical evidence");
        if (stored.lastObservationSequence === binding.lastObservationSequence) coversCurrentWatermark = true;
        retirements.push({ origin, lastObservationSequence: stored.lastObservationSequence,
          terminalEventId: stored.terminalEventId, artifactReferences: stored.artifactReferences });
      }
      if(opening && !retirements.some(receipt=>receipt.origin.processGeneration===opening.intent.processGeneration))
        throw new HarnessPersistenceError("stale_origin","Retired opening has no verified generation receipt");
      if (!coversCurrentWatermark)
        throw new HarnessPersistenceError("sequence_gap", "Retirement receipts do not cover the current ingress watermark");
      return { status: "verified_retirement" as const, selection: binding.selection, retirements };
    })();
  }
  private isSettled(turnId: string): boolean {
    const latest = this.database
      .prepare(
        "SELECT event_json FROM events WHERE family='lifecycle' AND stream_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(turnId) as { event_json: string } | undefined;
    return (
      latest !== undefined &&
      ["turn.completed", "turn.failed", "turn.interrupted"].includes(
        LifecycleEventSchema.parse(JSON.parse(latest.event_json)).type,
      )
    );
  }
  private requireClaim(turnId: string): void {
    const state = this.database
      .prepare(
        "SELECT execution_claim_id FROM harness_bindings WHERE turn_id=?",
      )
      .get(turnId) as { execution_claim_id: string | null } | undefined;
    if (!state?.execution_claim_id)
      throw new HarnessPersistenceError(
        "admission_required",
        "External execution requires a durable claim",
      );
  }
  async read(
    scope: Pick<StoredHarnessSelection, "userId" | "turnId" | "runAttemptId">,
  ): Promise<StoredHarnessBinding | null> {
    return this.readWithin(scope);
  }
  private readWithin(
    scope: Pick<StoredHarnessSelection, "userId" | "turnId" | "runAttemptId">,
  ): StoredHarnessBinding | null {
    const row = this.database
      .prepare(
        "SELECT selection_json,attachment_json,external_turn_id,last_observation_sequence FROM harness_bindings WHERE turn_id=? AND run_attempt_id=? AND user_id=?",
      )
      .get(scope.turnId, scope.runAttemptId, scope.userId) as
      | {
          selection_json: string;
          attachment_json: string | null;
          external_turn_id: string | null;
          last_observation_sequence: number;
        }
      | undefined;
    if (!row) return null;
    return {
      externalTurnId: row.external_turn_id,
      selection: StoredHarnessSelectionSchema.parse(
        JSON.parse(row.selection_json),
      ),
      attachment:
        row.attachment_json === null
          ? null
          : StoredHarnessAttachmentSchema.parse(
              JSON.parse(row.attachment_json),
            ),
      lastObservationSequence: row.last_observation_sequence,
    };
  }
  async attach(input: {
    selection: StoredHarnessSelection;
    origin: StoredHarnessAttachment;
    expectedProcessGeneration: string | null;
    events?: readonly LifecycleEvent[];
  }): Promise<StoredHarnessBinding> {
    return this.database.transaction(()=>this.attachWithin(input)).immediate();
  }
  private attachWithin(input: {
    selection: StoredHarnessSelection;
    origin: StoredHarnessAttachment;
    expectedProcessGeneration: string | null;
    events?: readonly LifecycleEvent[];
  }): StoredHarnessBinding {
        const binding = this.required(input.selection);
        this.requireClaim(input.selection.turnId);
        const opening=this.readOpeningWithin(input.selection);
        if(opening){
          assertHarnessOpeningOrigin(opening,input.origin);
          if(opening.phase!=="acknowledged" || !sameHarnessOrigin(binding.attachment,input.origin))
            throw new HarnessPersistenceError("stale_origin","Ordinary attachment cannot bypass durable opening acknowledgement");
        }
        if (this.isSettled(input.selection.turnId))
          throw new HarnessPersistenceError(
            "stale_origin",
            "Attempt is already settled",
          );
        if (sameHarnessOrigin(binding.attachment, input.origin)) return binding;
        assertHarnessAttachmentChange(
          binding,
          input.origin,
          input.expectedProcessGeneration,
        );
        const retired = this.database.prepare("SELECT 1 FROM harness_process_generations WHERE turn_id=? AND process_generation=?").get(input.selection.turnId, input.origin.processGeneration);
        if (retired) throw new HarnessPersistenceError("stale_origin", "A retired process generation cannot be reattached");
        this.database.prepare("INSERT INTO harness_process_generations(turn_id,process_generation,origin_json) VALUES (?,?,?)").run(input.selection.turnId, input.origin.processGeneration, JSON.stringify(input.origin));
        for (const event of input.events ?? []) {
          assertEventScope(input.selection, event);
          this.appendLifecycle(event);
        }
        this.database
          .prepare(
            "UPDATE harness_bindings SET attachment_json=?,last_observation_sequence=0 WHERE turn_id=?",
          )
          .run(JSON.stringify(input.origin), input.selection.turnId);
        return {
          ...binding,
          attachment: input.origin,
          lastObservationSequence: 0,
        };


  }
  async lookupObservation(
    input: Omit<HarnessObservationCommit, "events">,
  ): Promise<HarnessObservationAck | null> {
    validateHarnessObservation({ ...input, events: [] });
    return this.database
      .transaction(() => {
        const binding = this.required(input.selection);
        this.requireClaim(input.selection.turnId);
        assertHarnessOrigin(binding.attachment, input.origin);
        assertLearnedExternalTurn(binding, input.learnedExternalTurnId);
        const receipt = this.database
          .prepare(
            "SELECT observation_fingerprint,event_ids_json FROM harness_observation_receipts WHERE turn_id=? AND process_generation=? AND sequence=?",
          )
          .get(
            input.selection.turnId,
            input.origin.processGeneration,
            input.sequence,
          ) as
          | { observation_fingerprint: string; event_ids_json: string }
          | undefined;
        if (!receipt) return null;
        if (receipt.observation_fingerprint !== input.observationFingerprint)
          throw new HarnessPersistenceError(
            "observation_conflict",
            "Observation sequence already contains different evidence",
          );
        return {
          sequence: input.sequence,
          eventIds: this.validateCanonicalReferences(
            input.selection,
            receipt.event_ids_json,
          ),
          duplicate: true,
        };
      })
      .immediate();
  }
  async appendObservation(
    input: HarnessObservationCommit,
  ): Promise<HarnessObservationAck> {
    try {
      return this.database
        .transaction(() => this.appendObservationWithin(input))
        .immediate();
    } catch (error) {
      rethrowHarnessCommitFailure(error);
    }
  }
  /** Caller must own the current connection's transaction; used to add private
   * recovery facts to the SAME ingress/canonical append commit. */
  appendObservationWithin(
    input: HarnessObservationCommit,
  ): HarnessObservationAck {
    if (!this.database.inTransaction)
      throw new HarnessPersistenceError(
        "corrupt",
        "Canonical observation append requires the existing writer transaction",
      );
    validateHarnessObservation(input);
    const binding = this.required(input.selection);
    this.requireClaim(input.selection.turnId);
    assertHarnessOrigin(binding.attachment, input.origin);
    assertLearnedExternalTurn(binding, input.learnedExternalTurnId);
    const receipt = this.database
      .prepare(
        "SELECT observation_fingerprint,event_ids_json FROM harness_observation_receipts WHERE turn_id=? AND process_generation=? AND sequence=?",
      )
      .get(
        input.selection.turnId,
        input.origin.processGeneration,
        input.sequence,
      ) as
      | { observation_fingerprint: string; event_ids_json: string }
      | undefined;
    if (receipt) {
      if (receipt.observation_fingerprint !== input.observationFingerprint)
        throw new HarnessPersistenceError(
          "observation_conflict",
          "Observation sequence already contains different evidence",
        );
      return {
        sequence: input.sequence,
        eventIds: this.validateCanonicalReferences(
          input.selection,
          receipt.event_ids_json,
        ),
        duplicate: true,
      };
    }
    const latest = this.database
      .prepare(
        "SELECT event_json FROM events WHERE family='lifecycle' AND stream_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(input.selection.turnId) as { event_json: string } | undefined;
    if (
      latest &&
      ["turn.completed", "turn.failed", "turn.interrupted"].includes(
        LifecycleEventSchema.parse(JSON.parse(latest.event_json)).type,
      )
    )
      throw new HarnessPersistenceError(
        "stale_origin",
        "Attempt is already settled",
      );
    if (input.sequence !== binding.lastObservationSequence + 1)
      throw new HarnessPersistenceError(
        "sequence_gap",
        "Harness observation sequence has a gap",
      );
    const eventIds = input.events.map(
      (event) => this.appendLifecycle(event).eventId,
    );
    this.database
      .prepare(
        "INSERT INTO harness_observation_receipts(turn_id,process_generation,sequence,observation_fingerprint,event_ids_json) VALUES (?,?,?,?,?)",
      )
      .run(
        input.selection.turnId,
        input.origin.processGeneration,
        input.sequence,
        input.observationFingerprint,
        JSON.stringify(eventIds),
      );
    this.database
      .prepare(
        "UPDATE harness_bindings SET last_observation_sequence=?,external_turn_id=COALESCE(external_turn_id,?) WHERE turn_id=?",
      )
      .run(
        input.sequence,
        input.learnedExternalTurnId ?? null,
        input.selection.turnId,
      );
    return { sequence: input.sequence, eventIds, duplicate: false };
  }
  private validateCanonicalReferences(
    selection: StoredHarnessSelection,
    json: string,
  ): readonly string[] {
    const ids = z.array(z.string().min(1)).max(1000).parse(JSON.parse(json));
    for (const id of ids) {
      const row = this.database
        .prepare(
          "SELECT event_json FROM events WHERE family='lifecycle' AND event_id=?",
        )
        .get(id) as { event_json: string } | undefined;
      if (!row)
        throw new HarnessPersistenceError(
          "corrupt",
          "Observation receipt references missing canonical evidence",
        );
      const event = LifecycleEventSchema.parse(JSON.parse(row.event_json));
      assertEventScope(selection, event);
      if (event.eventId !== id)
        throw new HarnessPersistenceError(
          "corrupt",
          "Observation receipt canonical identity is invalid",
        );
    }
    return ids;
  }
  private required(selection: StoredHarnessSelection): StoredHarnessBinding {
    const binding = this.readWithin(selection);
    if (!binding)
      throw new HarnessPersistenceError(
        "binding_conflict",
        "Owned harness binding was not found",
      );
    assertHarnessSelection(binding.selection, selection);
    return binding;
  }
}

export function assertEventScope(
  selection: StoredHarnessSelection,
  value: LifecycleEvent,
): void {
  const event = LifecycleEventSchema.parse(value);
  if (
    event.threadId !== selection.threadId ||
    event.turnId !== selection.turnId ||
    event.runAttemptId !== selection.runAttemptId
  )
    throw new HarnessPersistenceError(
      "binding_conflict",
      "Canonical evidence does not match admitted attempt",
    );
}

export function assertLearnedExternalTurn(
  binding: StoredHarnessBinding,
  learned: string | null | undefined,
): void {
  if (
    learned !== undefined &&
    binding.externalTurnId !== null &&
    learned !== binding.externalTurnId
  )
    throw new HarnessPersistenceError(
      "binding_conflict",
      "External turn identity is already bound",
    );
}

export function sameHarnessOrigin(
  saved: StoredHarnessAttachment | null,
  requested: StoredHarnessAttachment,
): boolean {
  return (
    saved !== null &&
    createStableEventFingerprint(saved) ===
      createStableEventFingerprint(
        StoredHarnessAttachmentSchema.parse(requested),
      )
  );
}

/** Call only after the canonical worker observation schema has validated input. */
export async function fingerprintHarnessObservation(observation: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(createStableEventFingerprint(observation));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A connection/IO failure cannot prove that COMMIT did not become durable. */
export function rethrowHarnessCommitFailure(error: unknown): never {
  if (
    error instanceof HarnessPersistenceError ||
    error instanceof EventStoreError
  )
    throw error;
  throw new HarnessPersistenceError(
    "commit_outcome_unknown",
    "Observation commit outcome is unknown; fence ingress and restore canonical history before continuing",
  );
}

export function assertHarnessOpeningSelection(selection:StoredHarnessSelection,intent:HarnessOpeningIntent):void {
  const parsed=HarnessOpeningIntentSchema.parse(intent);
  const chosen=HarnessSelectionSchema.parse(JSON.parse(selection.selectionJson));
  if(parsed.runAttemptId!==selection.runAttemptId || parsed.instanceId!==chosen.instanceId ||
    parsed.authOwnerGeneration!==chosen.authOwnerGeneration || parsed.workspaceGrantId!==chosen.workspaceGrantId ||
    parsed.openingRef!==`${selection.runAttemptId}:${parsed.processGeneration}`)
    throw new HarnessPersistenceError("binding_conflict","Opening differs from immutable admitted selection");
}
export function assertHarnessOpeningIntent(opening:StoredHarnessOpening,intent:HarnessOpeningIntent):void {
  if(createStableEventFingerprint(opening.intent)!==createStableEventFingerprint(HarnessOpeningIntentSchema.parse(intent)))
    throw new HarnessPersistenceError("stale_origin","Opening intent cannot be replaced");
}
export function assertHarnessOpeningOrigin(opening:StoredHarnessOpening,raw:StoredHarnessAttachment):void {
  const origin=StoredHarnessAttachmentSchema.parse(raw);const intent=opening.intent;
  if(origin.instanceId!==intent.instanceId || origin.processGeneration!==intent.processGeneration || origin.authOwnerGeneration!==intent.authOwnerGeneration)
    throw new HarnessPersistenceError("stale_origin","Acknowledged native identity differs from opening generation");
}
export async function validateHarnessOpeningCommand(input:ReserveHarnessOpeningInput) {
  const selection=StoredHarnessSelectionSchema.parse(input.selection);
  const command=HarnessStartCommandSchema.parse(input.command);const intent=HarnessOpeningIntentSchema.parse(input.intent);
  assertHarnessOpeningSelection(selection,intent);
  if(command.mode!=="start" || command.resumeSession!==null ||
    createStableEventFingerprint(command.selection)!==createStableEventFingerprint(JSON.parse(selection.selectionJson)) ||
    intent.commandId!==command.commandId || intent.commandFingerprint!==await fingerprintHarnessCommand(command) ||
    intent.checkoutLeaseId!==command.leaseId || intent.startSnapshotId!==command.startSnapshot.snapshotKey ||
    command.startSnapshot.phase!=="start" || command.startSnapshot.turnId!==selection.turnId ||
    (intent.executionLease.kind==="local" && intent.executionLease.leaseId!==command.leaseId))
    throw new HarnessPersistenceError("binding_conflict","Opening command differs from frozen start evidence");
  return {selection,command,intent};
}
export function validateHarnessOpeningHistory(selection:StoredHarnessSelection,command:HarnessStartCommand,
  history:readonly LifecycleEvent[],workerId:string):void {
  if(history.length===0 || history.length>10000)throw new HarnessPersistenceError("corrupt","Opening requires bounded canonical start evidence");
  let started=false;let captured=false;
  for(const [index,event] of history.entries()){
    assertEventScope(selection,event);
    if(event.sequence!==index+1 || event.producer.id!==workerId)
      throw new HarnessPersistenceError("binding_conflict","Opening lifecycle sequence or admitted producer differs");
    if(["turn.completed","turn.failed","turn.interrupted"].includes(event.type))
      throw new HarnessPersistenceError("stale_origin","Terminal attempt cannot open a provider session");
    if(event.type==="turn.started")started=true;
    if(event.type==="workspace.snapshot_captured"){
      const wrapper=z.object({snapshot:TurnWorkspaceSnapshotSchema}).parse(event.payload.snapshot);
      if(wrapper.snapshot.phase==="start" && createStableEventFingerprint(wrapper.snapshot)===createStableEventFingerprint(command.startSnapshot))captured=true;
    }
  }
  if(!started || !captured)throw new HarnessPersistenceError("binding_conflict","Opening requires committed canonical start and exact snapshot");
}
