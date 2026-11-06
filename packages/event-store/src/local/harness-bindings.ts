import type Database from "better-sqlite3";
import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol/lifecycle";
import { z } from "zod";
import { LocalPersistenceError } from "../errors.js";
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
    processGeneration: z.number().int().nonnegative().safe(),
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
    readonly expectedProcessGeneration: number | null;
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
      | "corrupt",
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
  expected: number | null,
): void {
  StoredHarnessAttachmentSchema.parse(origin);
  const current = binding.attachment;
  if (
    (current?.processGeneration ?? null) !== expected ||
    (current && origin.processGeneration <= current.processGeneration)
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
CREATE TABLE harness_observation_receipts (
  turn_id TEXT NOT NULL REFERENCES harness_bindings(turn_id) ON DELETE CASCADE, process_generation INTEGER NOT NULL,
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
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('harness_bindings','harness_observation_receipts')",
    )
    .all();
  if (!marker && tables.length === 0) return false;
  if (marker?.value !== "1" || tables.length !== 2)
    throw new LocalPersistenceError(
      "corrupt",
      "Local harness schema is incomplete",
    );
  for (const [name, key] of [
    ["harness_bindings", ["turn_id"]],
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
  }
  return true;
}

export function initializeLocalHarnessBindings(
  database: Database.Database,
): void {
  if (validateLocalHarnessBindings(database)) return;
  database
    .transaction(() => {
      database.exec(LOCAL_SCHEMA);
      database
        .prepare(
          "INSERT INTO metadata(key,value) VALUES ('harness_bindings_version','1')",
        )
        .run();
    })
    .immediate();
}

export class LocalHarnessBindingRepository implements HarnessBindingRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly appendLifecycle: (event: LifecycleEvent) => LifecycleEvent,
  ) {}

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
    for (const event of events) {
      assertEventScope(selection, event);
      this.appendLifecycle(event);
    }
    const existing = this.readWithin(selection);
    if (existing) {
      assertHarnessSelection(existing.selection, selection);
      return existing;
    }
    // The local runtime owns admission/start; storage must not invent one.
    const admitted = this.database
      .prepare(
        "SELECT event_json FROM events WHERE family='lifecycle' AND stream_id=? AND json_extract(event_json, '$.type')='turn.started' ORDER BY sequence LIMIT 1",
      )
      .get(selection.turnId) as { event_json: string } | undefined;
    const first = admitted
      ? LifecycleEventSchema.parse(JSON.parse(admitted.event_json))
      : null;
    if (
      !first ||
      first.type !== "turn.started" ||
      first.threadId !== selection.threadId ||
      first.runAttemptId !== selection.runAttemptId
    ) {
      throw new HarnessPersistenceError(
        "admission_required",
        "Harness binding requires canonical local start evidence",
      );
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
        this.required(input.selection);
        if (this.isSettled(input.selection.turnId)) return false;
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
    expectedProcessGeneration: number | null;
    events?: readonly LifecycleEvent[];
  }): Promise<StoredHarnessBinding> {
    return this.database
      .transaction(() => {
        const binding = this.required(input.selection);
        this.requireClaim(input.selection.turnId);
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
      })
      .immediate();
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
          eventIds: z
            .array(z.string())
            .parse(JSON.parse(receipt.event_ids_json)),
          duplicate: true,
        };
      })
      .immediate();
  }
  async appendObservation(
    input: HarnessObservationCommit,
  ): Promise<HarnessObservationAck> {
    validateHarnessObservation(input);
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
        if (receipt) {
          if (receipt.observation_fingerprint !== input.observationFingerprint)
            throw new HarnessPersistenceError(
              "observation_conflict",
              "Observation sequence already contains different evidence",
            );
          return {
            sequence: input.sequence,
            eventIds: z
              .array(z.string())
              .parse(JSON.parse(receipt.event_ids_json)),
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
      })
      .immediate();
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
