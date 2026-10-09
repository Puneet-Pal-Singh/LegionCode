import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  EventCursorSchema,
  EventIdSchema,
  EVENT_SCHEMA_VERSION,
  EventScopeSchema,
  LocalTurnAdmissionSchema,
  LocalWorkspaceGrantPathSchema,
  LocalWorkspaceGrantSchema,
  PlatformEventSchema,
  ProviderIdSchema,
  type EventCursor,
  type EventId,
  type LocalTurnAdmission,
  type PlatformEvent,
  type LocalWorkspaceGrant,
  type ProviderId,
} from "@repo/platform-protocol";
import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol/lifecycle";
import { z } from "zod";
import { EventStoreError, LocalPersistenceError } from "./errors.js";
import { createStableEventFingerprint } from "./fingerprint.js";
import type {
  AppendEventInput,
  EventStore,
  EventStoreClock,
  EventStoreIdGenerator,
  ReplayEventsInput,
  ReplayEventsResult,
} from "./types.js";
import type {
  LifecycleEventStore,
  ReplayLifecycleEventsInput,
  ReplayLifecycleEventsResult,
} from "./lifecycle-types.js";

const DATABASE_NAME = "local-events.sqlite";
const SCHEMA_VERSION = 2;
const PRE_ADMISSION_SCHEMA_VERSION = 1;
const MAX_REPLAY_LIMIT = 1_000;
const PROVIDER_SELECTION_METADATA_KEY = "provider_selection_v1";
const ProviderSelectionSchema = z.object({
  version: z.literal(1),
  providerId: ProviderIdSchema,
  modelId: z.string().min(1).max(256).refine((value) => value.trim() === value),
}).strict();

const LegacyPlatformFileSchema = z.object({
  version: z.literal(1),
  events: z.array(z.unknown()),
}).strict();
const StoredGrantSchema = z.object({
  version: z.literal(1),
  path: LocalWorkspaceGrantPathSchema,
  grant: LocalWorkspaceGrantSchema,
}).strict();

export type StoredLocalWorkspaceGrant = {
  readonly version: 1;
  readonly path: string;
  readonly grant: LocalWorkspaceGrant;
};

export interface LocalPersistenceOptions {
  readonly storageDirectory: string;
  readonly clock?: EventStoreClock;
  readonly idGenerator?: EventStoreIdGenerator;
}

const systemClock: EventStoreClock = { now: () => new Date().toISOString() };
const systemIdGenerator: EventStoreIdGenerator = {
  nextEventId: () => `evt_${randomUUID()}` as EventId,
  nextCursor: () => `cursor_${randomUUID()}` as EventCursor,
};

type EventRow = {
  event_json: string;
  fingerprint: string;
  family: "platform" | "lifecycle";
  stream_id: string;
  stream_type: string;
  event_id: string;
  thread_id: string;
  turn_id: string | null;
  sequence: number;
  cursor: string | null;
  idempotency_key: string;
};

type TurnAdmissionRow = {
  workspace_id: string;
  thread_id: string;
  run_id: string;
  turn_id: string;
  run_attempt_id: string;
  idempotency_key: string;
  fingerprint: string;
  run_created_event_id: string;
  turn_started_event_id: string;
  user_message_completed_event_id: string;
};

/**
 * One process-owned SQLite writer for all local durable product records.
 * Construction performs validation and one-time legacy migration synchronously,
 * before the local App Server can announce readiness.
 */
export class LocalPersistence {
  readonly events: EventStore & { listAll(): Promise<readonly PlatformEvent[]> };
  readonly lifecycleEvents: LifecycleEventStore;
  readonly workspaceGrants: {
    read(): Promise<StoredLocalWorkspaceGrant | null>;
    write(value: StoredLocalWorkspaceGrant): Promise<void>;
    clear(): Promise<void>;
  };
  readonly providerSelection: {
    read(): Promise<{ readonly providerId: ProviderId; readonly modelId: string } | null>;
    write(value: { readonly providerId: ProviderId; readonly modelId: string }): Promise<void>;
    clear(): Promise<void>;
  };
  readonly turnAdmissions: {
    admit(candidate: LocalTurnAdmission): Promise<{
      readonly entry: LocalTurnAdmission;
      readonly newlyAdmitted: boolean;
    }>;
    listByThreadWorkspace(input: {
      readonly workspaceId: LocalTurnAdmission["identity"]["workspaceId"];
      readonly threadId: LocalTurnAdmission["identity"]["threadId"];
    }): Promise<readonly LocalTurnAdmission[]>;
  };

  private readonly database!: Database.Database;
  private readonly storageDirectory: string;
  private readonly clock: EventStoreClock;
  private readonly idGenerator: EventStoreIdGenerator;
  private closed = false;

  constructor(options: LocalPersistenceOptions) {
    if (!isAbsolute(options.storageDirectory) || options.storageDirectory.includes("\0")) {
      throw new LocalPersistenceError("unavailable", "Local persistence requires an absolute storage directory");
    }
    this.storageDirectory = options.storageDirectory;
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? systemIdGenerator;
    try {
      mkdirSync(this.storageDirectory, { recursive: true, mode: 0o700 });
      const databasePath = join(this.storageDirectory, DATABASE_NAME);
      const existed = existsSync(databasePath);
      this.assertRecoveryEvidenceBeforeOpen(databasePath, existed);
      this.database = new Database(databasePath, { timeout: 0 });
      if (!existed) chmodSync(databasePath, 0o600);
      this.assertArchiveMarkerInOpenDatabase();
      if (existed) this.validateExistingDatabaseBeforeMutation();
      this.configureAndAcquireExclusiveLock();
      this.createSchemaIfNew();
      this.migrateOrValidate();
      this.validateDatabase();
      this.archiveLegacyFilesAfterCommit();
    } catch (error) {
      this.database?.close();
      throw sanitizeOpenError(error);
    }

    this.events = {
      append: async (input) => this.appendPlatform(input),
      appendBatch: async (inputs) => this.appendPlatformBatch(inputs),
      replay: async (input) => this.replayPlatform(input),
      listAll: async () => this.listAllPlatform(),
    };
    this.lifecycleEvents = {
      append: async (event) => this.appendLifecycle(event),
      appendBatch: async (events) => this.appendLifecycleBatch(events),
      replay: async (input) => this.replayLifecycle(input),
    };
    this.workspaceGrants = {
      read: async () => this.readWorkspaceGrant(),
      write: async (value) => this.writeWorkspaceGrant(value),
      clear: async () => this.clearWorkspaceGrant(),
    };
    this.providerSelection = {
      read: async () => this.readProviderSelection(),
      write: async (value) => this.writeProviderSelection(value),
      clear: async () => this.clearProviderSelection(),
    };
    this.turnAdmissions = {
      admit: async (candidate) => this.admitTurn(candidate),
      listByThreadWorkspace: async (input) => this.listTurnAdmissions(input),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private configureAndAcquireExclusiveLock(): void {
    this.database.pragma("busy_timeout = 0");
    const journalMode = this.database.pragma("journal_mode = WAL", { simple: true });
    if (String(journalMode).toLowerCase() !== "wal") {
      throw corruptStore("SQLite WAL mode could not be enabled");
    }
    this.database.pragma("synchronous = FULL");
    const synchronous = this.database.pragma("synchronous", { simple: true });
    if (synchronous !== 2) throw corruptStore("SQLite FULL durability is unavailable");
    this.database.pragma("locking_mode = EXCLUSIVE");
    const lockingMode = this.database.pragma("locking_mode", { simple: true });
    if (String(lockingMode).toLowerCase() !== "exclusive") {
      throw corruptStore("SQLite exclusive locking is unavailable");
    }
    // This transaction acquires SQLite's real exclusive lock before migration
    // and readiness without leaving a probe table or row behind.
    this.database.exec("BEGIN EXCLUSIVE");
    try {
      this.database.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private createSchemaIfNew(): void {
    const tables = this.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as { name: string }[];
    if (tables.length > 0) {
      const present = new Set(tables.map(({ name }) => name));
      if (!present.has("metadata") || !present.has("events") || !present.has("workspace_grant")) {
        throw new LocalPersistenceError("corrupt", "Local database schema is incomplete");
      }
      const schemaVersion = this.database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (schemaVersion && ![String(PRE_ADMISSION_SCHEMA_VERSION), String(SCHEMA_VERSION)].includes(schemaVersion.value)) {
        throw new LocalPersistenceError("corrupt", "Local database schema version is unsupported");
      }
      const marker = this.database.prepare("SELECT value FROM metadata WHERE key = 'legacy_migration_complete'").get() as { value: string } | undefined;
      const records = this.database.prepare("SELECT 1 FROM events UNION ALL SELECT 1 FROM workspace_grant LIMIT 1").get();
      if (!marker && records) throw new LocalPersistenceError("corrupt", "Local database is populated without a migration marker");
      return;
    }
    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE metadata (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE events (
          insertion_order INTEGER PRIMARY KEY AUTOINCREMENT,
          family TEXT NOT NULL CHECK (family IN ('platform', 'lifecycle')),
          event_id TEXT NOT NULL UNIQUE,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          stream_type TEXT NOT NULL,
          stream_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          cursor TEXT UNIQUE,
          idempotency_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          event_json TEXT NOT NULL,
          UNIQUE (family, stream_type, stream_id, sequence),
          UNIQUE (family, stream_type, stream_id, idempotency_key)
        );
        CREATE INDEX events_family_order ON events(family, insertion_order);
        CREATE INDEX events_stream_order ON events(family, stream_type, stream_id, sequence);
        CREATE TABLE workspace_grant (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          value_json TEXT NOT NULL
        );
        CREATE TABLE turn_admissions (
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE,
          turn_id TEXT NOT NULL UNIQUE,
          run_attempt_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          run_created_event_id TEXT NOT NULL UNIQUE,
          turn_started_event_id TEXT NOT NULL UNIQUE,
          user_message_completed_event_id TEXT NOT NULL UNIQUE,
          PRIMARY KEY (workspace_id, thread_id, idempotency_key)
        ) WITHOUT ROWID;
      `);
    }).exclusive();
  }

  private migrateOrValidate(): void {
    const version = this.database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (version && ![String(PRE_ADMISSION_SCHEMA_VERSION), String(SCHEMA_VERSION)].includes(version.value)) {
      throw corruptStore("Local database schema version is unsupported");
    }
    const marker = this.database.prepare("SELECT value FROM metadata WHERE key = 'legacy_migration_complete'").get() as { value: string } | undefined;
    if (marker) {
      if (marker.value !== "1") throw corruptStore("Local migration marker is invalid");
      if (version?.value === String(PRE_ADMISSION_SCHEMA_VERSION)) {
        this.migrateAdmissionIndex();
      }
      return;
    }
    if (this.hasArchivedMigrationEvidence()) {
      throw corruptStore("Archived migration evidence has no matching database marker");
    }

    const hasRecords = (this.database.prepare("SELECT 1 FROM events LIMIT 1").get() !== undefined)
      || (this.database.prepare("SELECT 1 FROM workspace_grant LIMIT 1").get() !== undefined);
    if (hasRecords) throw corruptStore("Local database is populated without a migration marker");

    const platformEvents = this.readLegacyPlatformEvents();
    const storedGrant = this.readLegacyGrant();
    this.database.transaction(() => {
      for (const event of platformEvents) this.insertMigratedPlatformEvent(event);
      if (storedGrant) {
        this.database.prepare("INSERT INTO workspace_grant(id, value_json) VALUES (1, ?)")
          .run(JSON.stringify(storedGrant));
      }
      this.database.prepare("INSERT INTO metadata(key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
      this.database.prepare("INSERT INTO metadata(key, value) VALUES ('legacy_migration_complete', '1')").run();
    }).exclusive();
  }

  private migrateAdmissionIndex(): void {
    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE turn_admissions (
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE,
          turn_id TEXT NOT NULL UNIQUE,
          run_attempt_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          run_created_event_id TEXT NOT NULL UNIQUE,
          turn_started_event_id TEXT NOT NULL UNIQUE,
          user_message_completed_event_id TEXT NOT NULL UNIQUE,
          PRIMARY KEY (workspace_id, thread_id, idempotency_key)
        ) WITHOUT ROWID;
      `);
      this.database.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'")
        .run(String(SCHEMA_VERSION));
    }).exclusive();
  }

  private readLegacyPlatformEvents(): PlatformEvent[] {
    const filePath = join(this.storageDirectory, "thread-events.json");
    if (!existsSync(filePath)) return [];
    try {
      const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const file = LegacyPlatformFileSchema.parse(raw);
      return file.events.map((event) => PlatformEventSchema.parse(event));
    } catch {
      throw corruptStore("Legacy local event data is invalid");
    }
  }

  private readLegacyGrant(): StoredLocalWorkspaceGrant | null {
    const filePath = join(this.storageDirectory, "workspace-grant.json");
    if (!existsSync(filePath)) return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      return parseStoredGrant(raw);
    } catch {
      throw corruptStore("Legacy workspace grant data is invalid");
    }
  }

  private insertMigratedPlatformEvent(event: PlatformEvent): void {
    const streamType = event.scopeType;
    const previous = this.database.prepare(`
      SELECT sequence FROM events WHERE family = 'platform' AND stream_type = ? AND stream_id = ? ORDER BY sequence DESC LIMIT 1
    `).get(streamType, event.scopeId) as { sequence: number } | undefined;
    if (event.sequence !== (previous?.sequence ?? 0) + 1) {
      throw corruptStore("Legacy local event sequence is invalid");
    }
    this.insertEvent({
      family: "platform",
      eventId: event.eventId,
      threadId: event.threadId,
      turnId: null,
      streamType,
      streamId: event.scopeId,
      sequence: event.sequence,
      cursor: event.cursor,
      idempotencyKey: event.idempotencyKey,
      fingerprint: platformFingerprint(event),
      event,
    });
  }

  private appendPlatform(input: AppendEventInput): PlatformEvent {
    return this.guardStorage(() => this.database.transaction(() => this.appendPlatformWithin(input)).immediate());
  }

  private appendPlatformBatch(inputs: readonly AppendEventInput[]): readonly PlatformEvent[] {
    return this.guardStorage(() => this.database.transaction(() => inputs.map((input) => this.appendPlatformWithin(input))).immediate());
  }

  private appendPlatformWithin(input: AppendEventInput): PlatformEvent {
    const scope = EventScopeSchema.parse({ scopeType: input.scopeType, scopeId: input.scopeId });
    const existing = this.database.prepare(`
      SELECT event_json, fingerprint, family, stream_id, stream_type, event_id, thread_id,
        turn_id, sequence, cursor, idempotency_key
      FROM events WHERE family = 'platform' AND stream_type = ? AND stream_id = ? AND idempotency_key = ?
    `).get(scope.scopeType, scope.scopeId, input.idempotencyKey) as EventRow | undefined;
    if (existing) {
      const saved = parseStoredPlatformEvent(existing.event_json);
      const retry = PlatformEventSchema.parse({
        ...input,
        eventId: saved.eventId,
        cursor: saved.cursor,
        sequence: saved.sequence,
        createdAt: saved.createdAt,
      });
      if (existing.fingerprint !== platformFingerprint(retry)) {
        throw new EventStoreError("idempotency_conflict", "Idempotency key was already used for a different event");
      }
      return saved;
    }
    const last = this.database.prepare(`
      SELECT sequence FROM events WHERE family = 'platform' AND stream_type = ? AND stream_id = ? ORDER BY sequence DESC LIMIT 1
    `).get(scope.scopeType, scope.scopeId) as { sequence: number } | undefined;
    const event = PlatformEventSchema.parse({
      ...input,
      eventId: this.idGenerator.nextEventId(),
      cursor: this.idGenerator.nextCursor(),
      sequence: (last?.sequence ?? 0) + 1,
      createdAt: this.clock.now(),
    });
    this.insertEvent({
      family: "platform", eventId: event.eventId, threadId: event.threadId, turnId: null,
      streamType: event.scopeType, streamId: event.scopeId, sequence: event.sequence,
      cursor: event.cursor, idempotencyKey: event.idempotencyKey, fingerprint: platformFingerprint(event),
      event,
    });
    return event;
  }

  private appendLifecycle(event: LifecycleEvent): LifecycleEvent {
    return this.guardStorage(() => this.database.transaction(() => this.appendLifecycleWithin(event)).immediate());
  }

  private appendLifecycleBatch(events: readonly LifecycleEvent[]): readonly LifecycleEvent[] {
    return this.guardStorage(() => this.database.transaction(() => events.map((event) => this.appendLifecycleWithin(event))).immediate());
  }

  private appendLifecycleWithin(input: LifecycleEvent): LifecycleEvent {
    const event = parseLifecycleEvent(input);
    const fingerprint = createStableEventFingerprint(event);
    const existing = this.database.prepare(`
      SELECT event_json, fingerprint, family, stream_id, sequence, idempotency_key
      FROM events WHERE family = 'lifecycle' AND stream_type = 'turn' AND stream_id = ? AND idempotency_key = ?
    `).get(event.turnId, event.idempotencyKey) as EventRow | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new EventStoreError("idempotency_conflict", "Lifecycle idempotency key was already used for a different event");
      }
      return parseStoredLifecycleEvent(existing.event_json);
    }
    const stream = this.database.prepare(`
      SELECT thread_id, sequence, event_json FROM events
      WHERE family = 'lifecycle' AND stream_type = 'turn' AND stream_id = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(event.turnId) as { thread_id: string; sequence: number; event_json: string } | undefined;
    if (stream && stream.thread_id !== event.threadId) {
      throw new EventStoreError("corrupt_event_stream", "Lifecycle turn identity changed thread");
    }
    if (stream && isTerminal(parseStoredLifecycleEvent(stream.event_json))) {
      throw new EventStoreError("terminal_stream", "Turn already has terminal lifecycle evidence");
    }
    const expected = (stream?.sequence ?? 0) + 1;
    if (event.sequence !== expected) {
      throw new EventStoreError("sequence_gap", `Lifecycle sequence must be ${expected}, received ${event.sequence}`);
    }
    this.insertEvent({
      family: "lifecycle", eventId: event.eventId, threadId: event.threadId,
      turnId: event.turnId, streamType: "turn", streamId: event.turnId,
      sequence: event.sequence, cursor: null, idempotencyKey: event.idempotencyKey,
      fingerprint, event,
    });
    return event;
  }

  private insertEvent(input: {
    family: "platform" | "lifecycle";
    eventId: string;
    threadId: string;
    turnId: string | null;
    streamType: string;
    streamId: string;
    sequence: number;
    cursor: string | null;
    idempotencyKey: string;
    fingerprint: string;
    event: PlatformEvent | LifecycleEvent;
  }): void {
    try {
      this.database.prepare(`
        INSERT INTO events(family, event_id, thread_id, turn_id, stream_type, stream_id, sequence, cursor, idempotency_key, fingerprint, event_json)
        VALUES (@family, @eventId, @threadId, @turnId, @streamType, @streamId, @sequence, @cursor, @idempotencyKey, @fingerprint, @eventJson)
      `).run({ ...input, eventJson: JSON.stringify(input.event) });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code.startsWith("SQLITE_CONSTRAINT")) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("events.cursor")) {
          throw new EventStoreError("cursor_conflict", "Generated event cursor already exists");
        }
        throw new EventStoreError("event_id_conflict", "Local event identity conflicts with existing history");
      }
      throw new LocalPersistenceError("unavailable", "Local event could not be stored safely");
    }
  }

  private replayPlatform(input: ReplayEventsInput): ReplayEventsResult {
    return this.guardStorage(() => this.replayPlatformWithin(input));
  }

  private replayPlatformWithin(input: ReplayEventsInput): ReplayEventsResult {
    const scope = EventScopeSchema.parse(input.scope);
    validateReplayLimit(input.limit);
    const afterCursor = input.afterCursor === null ? null : EventCursorSchema.parse(input.afterCursor);
    const rows = this.database.prepare(`
      SELECT event_json FROM events WHERE family = 'platform' AND stream_type = ? AND stream_id = ? ORDER BY sequence
    `).all(scope.scopeType, scope.scopeId) as { event_json: string }[];
    const events = rows.map(({ event_json }) => parseStoredPlatformEvent(event_json));
    const start = afterCursor === null ? 0 : events.findIndex((event) => event.cursor === afterCursor) + 1;
    if (afterCursor !== null && start === 0) {
      throw new EventStoreError("cursor_not_found", "Replay cursor does not exist in the requested scope");
    }
    const page = events.slice(start, start + input.limit);
    return { events: page, nextCursor: page.at(-1)?.cursor ?? null };
  }

  private replayLifecycle(input: ReplayLifecycleEventsInput): ReplayLifecycleEventsResult {
    return this.guardStorage(() => this.replayLifecycleWithin(input));
  }

  private replayLifecycleWithin(input: ReplayLifecycleEventsInput): ReplayLifecycleEventsResult {
    validateReplayLimit(input.limit);
    if (input.afterSequence !== null && (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0)) {
      throw new EventStoreError("cursor_not_found", "Invalid lifecycle replay sequence");
    }
    const after = input.afterSequence ?? 0;
    const rows = this.database.prepare(`
      SELECT event_json FROM events WHERE family = 'lifecycle' AND stream_type = 'turn' AND stream_id = ? AND sequence > ?
      ORDER BY sequence LIMIT ?
    `).all(input.turnId, after, input.limit) as { event_json: string }[];
    const events = rows.map(({ event_json }) => parseStoredLifecycleEvent(event_json));
    for (const [index, event] of events.entries()) {
      if (event.sequence !== after + index + 1) {
        throw new EventStoreError("corrupt_event_stream", "Lifecycle replay contains a sequence gap");
      }
    }
    return { events, nextSequence: events.at(-1)?.sequence ?? null };
  }

  private listAllPlatform(): readonly PlatformEvent[] {
    return this.guardStorage(() => {
      const rows = this.database.prepare("SELECT event_json FROM events WHERE family = 'platform' ORDER BY insertion_order").all() as { event_json: string }[];
      return rows.map(({ event_json }) => parseStoredPlatformEvent(event_json));
    });
  }

  private admitTurn(candidateInput: LocalTurnAdmission): {
    readonly entry: LocalTurnAdmission;
    readonly newlyAdmitted: boolean;
  } {
    const candidate = LocalTurnAdmissionSchema.parse(candidateInput);
    const fingerprint = admissionFingerprint(candidate);
    return this.guardStorage(() => this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT * FROM turn_admissions WHERE workspace_id = ? AND thread_id = ? AND idempotency_key = ?
      `).get(candidate.identity.workspaceId, candidate.identity.threadId, candidate.idempotencyKey) as TurnAdmissionRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new EventStoreError("idempotency_conflict", "Turn admission key was already used for a different request");
        }
        return { entry: this.reconstructTurnAdmission(existing), newlyAdmitted: false };
      }
      const identity = candidate.identity;
      const duplicateIdentity = this.database.prepare(`
        SELECT 1 FROM turn_admissions WHERE run_id = ? OR turn_id = ? LIMIT 1
      `).get(identity.runId, identity.turnId);
      if (duplicateIdentity) {
        throw new EventStoreError("event_id_conflict", "Turn admission identity already belongs to another request");
      }
      const stream = this.database.prepare(`
        SELECT 1 FROM events WHERE family = 'platform' AND stream_type = 'run' AND stream_id = ? LIMIT 1
      `).get(identity.runId);
      if (stream) throw new EventStoreError("event_id_conflict", "Run already has canonical event history");

      const runCreated = this.appendPlatformWithin({
        threadId: identity.threadId,
        workspaceId: identity.workspaceId,
        runId: identity.runId,
        scopeType: "run",
        scopeId: identity.runId,
        type: "run.created",
        payload: { run: candidate.run },
        idempotencyKey: admissionEventKey(identity.runId, "run-created"),
        producer: { kind: "runtime_kernel", id: "local-admission" },
        schemaVersion: EVENT_SCHEMA_VERSION,
      });
      const turnStarted = this.appendPlatformWithin({
        threadId: identity.threadId,
        workspaceId: identity.workspaceId,
        runId: identity.runId,
        scopeType: "run",
        scopeId: identity.runId,
        type: "turn.started",
        payload: { turn: candidate.turn },
        idempotencyKey: admissionEventKey(identity.runId, "turn-started"),
        producer: { kind: "runtime_kernel", id: "local-admission" },
        schemaVersion: EVENT_SCHEMA_VERSION,
      });
      const userMessageCompleted = this.appendPlatformWithin({
        threadId: identity.threadId,
        workspaceId: identity.workspaceId,
        runId: identity.runId,
        scopeType: "run",
        scopeId: identity.runId,
        type: "item.completed",
        payload: { item: candidate.userMessage },
        idempotencyKey: admissionEventKey(identity.runId, "user-message"),
        producer: { kind: "runtime_kernel", id: "local-admission" },
        schemaVersion: EVENT_SCHEMA_VERSION,
      });
      if (runCreated.sequence !== 1 || turnStarted.sequence !== 2
        || userMessageCompleted.sequence !== 3
        || candidate.userMessage.eventSequence !== userMessageCompleted.sequence) {
        throw new EventStoreError("sequence_gap", "Local turn admission event sequence is inconsistent");
      }
      this.database.prepare(`
        INSERT INTO turn_admissions(
          workspace_id, thread_id, run_id, turn_id, run_attempt_id,
          idempotency_key, fingerprint, run_created_event_id, turn_started_event_id,
          user_message_completed_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        identity.workspaceId,
        identity.threadId,
        identity.runId,
        identity.turnId,
        identity.runAttemptId,
        candidate.idempotencyKey,
        fingerprint,
        runCreated.eventId,
        turnStarted.eventId,
        userMessageCompleted.eventId,
      );
      const row = this.database.prepare(`
        SELECT * FROM turn_admissions WHERE workspace_id = ? AND thread_id = ? AND idempotency_key = ?
      `).get(identity.workspaceId, identity.threadId, candidate.idempotencyKey) as TurnAdmissionRow;
      return { entry: this.reconstructTurnAdmission(row), newlyAdmitted: true };
    }).immediate());
  }

  private listTurnAdmissions(input: {
    readonly workspaceId: LocalTurnAdmission["identity"]["workspaceId"];
    readonly threadId: LocalTurnAdmission["identity"]["threadId"];
  }): readonly LocalTurnAdmission[] {
    return this.guardStorage(() => {
      const rows = this.database.prepare(`
        SELECT admission.* FROM turn_admissions AS admission
        JOIN events AS accepted ON accepted.event_id = admission.run_created_event_id
        WHERE admission.workspace_id = ? AND admission.thread_id = ?
        ORDER BY accepted.insertion_order
      `).all(input.workspaceId, input.threadId) as TurnAdmissionRow[];
      return rows.map((row) => this.reconstructTurnAdmission(row));
    });
  }

  private reconstructTurnAdmission(row: TurnAdmissionRow): LocalTurnAdmission {
    try {
      const refs = [
        EventIdSchema.parse(row.run_created_event_id),
        EventIdSchema.parse(row.turn_started_event_id),
        EventIdSchema.parse(row.user_message_completed_event_id),
      ];
      const events = refs.map((eventId) => {
        const stored = this.database.prepare("SELECT event_json FROM events WHERE family = 'platform' AND event_id = ?")
          .get(eventId) as { event_json: string } | undefined;
        if (!stored) throw new Error("Admission event reference is missing");
        return parseStoredPlatformEvent(stored.event_json);
      });
      const [runCreated, turnStarted, itemCompleted] = events;
      if (runCreated?.type !== "run.created" || turnStarted?.type !== "turn.started"
        || itemCompleted?.type !== "item.completed") throw new Error("Admission event types are invalid");
      if (runCreated.sequence !== 1 || turnStarted.sequence !== 2 || itemCompleted.sequence !== 3) {
        throw new Error("Admission event sequence is invalid");
      }
      const admission = LocalTurnAdmissionSchema.parse({
        identity: {
          workspaceId: row.workspace_id,
          threadId: row.thread_id,
          runId: row.run_id,
          turnId: row.turn_id,
          runAttemptId: row.run_attempt_id,
        },
        run: runCreated.payload.run,
        turn: turnStarted.payload.turn,
        userMessage: itemCompleted.payload.item,
        providerId: (runCreated.payload.run as LocalTurnAdmission["run"]).providerId,
        modelId: (runCreated.payload.run as LocalTurnAdmission["run"]).modelId,
        idempotencyKey: row.idempotency_key,
      });
      if (runCreated.eventId !== refs[0] || turnStarted.eventId !== refs[1] || itemCompleted.eventId !== refs[2]
        || events.some((event) => event.threadId !== row.thread_id || event.workspaceId !== row.workspace_id
          || event.runId !== row.run_id || event.scopeType !== "run" || event.scopeId !== row.run_id)
        || admission.turn.id !== row.turn_id || admission.identity.runAttemptId !== row.run_attempt_id
        || admissionFingerprint(admission) !== row.fingerprint) {
        throw new Error("Admission index does not match canonical event history");
      }
      return admission;
    } catch {
      throw corruptStore("Local turn admission index does not match canonical event history");
    }
  }

  private readWorkspaceGrant(): StoredLocalWorkspaceGrant | null {
    return this.guardStorage(() => {
      const row = this.database.prepare("SELECT value_json FROM workspace_grant WHERE id = 1").get() as { value_json: string } | undefined;
      if (!row) return null;
      try { return parseStoredGrant(JSON.parse(row.value_json)); }
      catch { throw corruptStore("Stored workspace grant is invalid"); }
    });
  }

  private writeWorkspaceGrant(value: StoredLocalWorkspaceGrant): void {
    let parsed: StoredLocalWorkspaceGrant;
    try { parsed = parseStoredGrant(value); }
    catch { throw corruptStore("Workspace grant is invalid"); }
    this.guardStorage(() => this.database.transaction(() => {
      this.database.prepare(`INSERT INTO workspace_grant(id, value_json) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json`).run(JSON.stringify(parsed));
    }).immediate());
  }

  private clearWorkspaceGrant(): void {
    this.guardStorage(() => this.database.transaction(() => this.database.prepare("DELETE FROM workspace_grant WHERE id = 1").run()).immediate());
  }

  private readProviderSelection(): { readonly providerId: ProviderId; readonly modelId: string } | null {
    return this.guardStorage(() => {
      const row = this.database.prepare("SELECT value FROM metadata WHERE key = ?")
        .get(PROVIDER_SELECTION_METADATA_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        const { providerId, modelId } = ProviderSelectionSchema.parse(JSON.parse(row.value));
        return { providerId, modelId };
      } catch {
        throw corruptStore("Stored provider selection is invalid");
      }
    });
  }

  private writeProviderSelection(value: { readonly providerId: ProviderId; readonly modelId: string }): void {
    let selection: z.infer<typeof ProviderSelectionSchema>;
    try {
      selection = ProviderSelectionSchema.parse({ version: 1, ...value });
    } catch {
      throw corruptStore("Provider selection is invalid");
    }
    this.guardStorage(() => this.database.transaction(() => {
      this.database.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(PROVIDER_SELECTION_METADATA_KEY, JSON.stringify(selection));
    }).immediate());
  }

  private clearProviderSelection(): void {
    this.guardStorage(() => this.database.transaction(() => {
      this.database.prepare("DELETE FROM metadata WHERE key = ?").run(PROVIDER_SELECTION_METADATA_KEY);
    }).immediate());
  }

  private guardStorage<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof EventStoreError || error instanceof LocalPersistenceError) throw error;
      throw new LocalPersistenceError("unavailable", "Local persistence operation failed safely");
    }
  }

  private validateDatabase(expectedVersion = SCHEMA_VERSION): void {
    const result = this.database.pragma("quick_check") as { quick_check: string }[];
    if (result.length !== 1 || result[0]?.quick_check !== "ok") throw corruptStore("Local database integrity check failed");
    const marker = this.database.prepare("SELECT value FROM metadata WHERE key = 'legacy_migration_complete'").get() as { value: string } | undefined;
    const version = this.database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (marker?.value !== "1" || version?.value !== String(expectedVersion)) throw corruptStore("Local database metadata is invalid");
    this.assertRequiredIndexes();
    this.validateProviderSelectionMetadata();

    const rows = this.database.prepare(`
      SELECT family, event_json, fingerprint, event_id, thread_id, turn_id,
        stream_type, stream_id, sequence, cursor, idempotency_key
      FROM events ORDER BY insertion_order
    `).all() as EventRow[];
    if (this.database.prepare("SELECT 1 FROM workspace_grant WHERE id != 1 LIMIT 1").get()) {
      throw corruptStore("Stored workspace grant identity is invalid");
    }
    const platformSequence = new Map<string, number>();
    const lifecycleSequence = new Map<string, { sequence: number; threadId: string; terminal: boolean }>();
    for (const row of rows) {
      if (row.family === "platform") {
        const event = parseStoredPlatformEvent(row.event_json);
        const key = `${event.scopeType}:${event.scopeId}`;
        const expected = (platformSequence.get(key) ?? 0) + 1;
        if (event.sequence !== expected) throw corruptStore("Local platform event sequence is invalid");
        if (row.event_id !== event.eventId || row.thread_id !== event.threadId || row.turn_id !== null
          || row.stream_type !== event.scopeType || row.stream_id !== event.scopeId
          || row.sequence !== event.sequence || row.cursor !== event.cursor
          || row.idempotency_key !== event.idempotencyKey || row.fingerprint !== platformFingerprint(event)) {
          throw corruptStore("Local platform event index is inconsistent");
        }
        platformSequence.set(key, event.sequence);
      } else if (row.family === "lifecycle") {
        const event = parseStoredLifecycleEvent(row.event_json);
        const previous = lifecycleSequence.get(event.turnId);
        if (previous && (previous.threadId !== event.threadId || previous.terminal)) throw corruptStore("Local lifecycle stream identity is invalid");
        const expected = (previous?.sequence ?? 0) + 1;
        if (event.sequence !== expected) throw corruptStore("Local lifecycle event sequence is invalid");
        if (row.event_id !== event.eventId || row.thread_id !== event.threadId || row.turn_id !== event.turnId
          || row.stream_type !== "turn" || row.stream_id !== event.turnId
          || row.sequence !== event.sequence || row.cursor !== null
          || row.idempotency_key !== event.idempotencyKey
          || row.fingerprint !== createStableEventFingerprint(event)) {
          throw corruptStore("Local lifecycle event index is inconsistent");
        }
        lifecycleSequence.set(event.turnId, { sequence: event.sequence, threadId: event.threadId, terminal: isTerminal(event) });
      } else {
        throw corruptStore("Local event family is invalid");
      }
    }
    this.readWorkspaceGrant();
    if (expectedVersion === SCHEMA_VERSION) {
      this.assertTurnAdmissionIndex();
      this.validateTurnAdmissions();
    }
  }

  private validateProviderSelectionMetadata(): void {
    const row = this.database.prepare("SELECT value FROM metadata WHERE key = ?")
      .get(PROVIDER_SELECTION_METADATA_KEY) as { value: string } | undefined;
    if (!row) return;
    try {
      ProviderSelectionSchema.parse(JSON.parse(row.value));
    } catch {
      throw corruptStore("Stored provider selection is invalid");
    }
  }

  private assertRequiredIndexes(): void {
    this.assertRequiredTableKeys();
    const indexes = this.database.pragma("index_list(events)") as { name: string; unique: number; partial: number; origin: string }[];
    const columnsByIndex = new Map<string, readonly string[]>();
    for (const index of indexes) {
      const escapedName = index.name.replaceAll("'", "''");
      const columns = this.database.pragma(`index_info('${escapedName}')`) as { name: string | null }[];
      columnsByIndex.set(index.name, columns.map(({ name }) => name ?? ""));
    }
    const hasIndex = (columns: readonly string[], unique: boolean): boolean => indexes.some((index) => {
      const actual = columnsByIndex.get(index.name) ?? [];
      return Boolean(index.unique) === unique && index.partial === 0 && actual.length === columns.length
        && actual.every((column, position) => column === columns[position]);
    });
    const requiredUnique = [
      ["event_id"],
      ["cursor"],
      ["family", "stream_type", "stream_id", "sequence"],
      ["family", "stream_type", "stream_id", "idempotency_key"],
    ] as const;
    if (requiredUnique.some((columns) => !hasIndex(columns, true))) {
      throw corruptStore("Local database uniqueness constraints are incomplete");
    }
    if (!hasIndex(["family", "insertion_order"], false)
      || !hasIndex(["family", "stream_type", "stream_id", "sequence"], false)) {
      throw corruptStore("Local database lookup indexes are incomplete");
    }
  }

  private validateTurnAdmissions(): void {
    const rows = this.database.prepare("SELECT * FROM turn_admissions")
      .all() as TurnAdmissionRow[];
    for (const row of rows) this.reconstructTurnAdmission(row);
  }

  private assertTurnAdmissionIndex(): void {
    const columns = this.database.pragma("table_info(turn_admissions)") as { name: string; type: string; pk: number }[];
    const expected = [
      ["workspace_id", "TEXT"],
      ["thread_id", "TEXT"],
      ["run_id", "TEXT"],
      ["turn_id", "TEXT"],
      ["run_attempt_id", "TEXT"],
      ["idempotency_key", "TEXT"],
      ["fingerprint", "TEXT"],
      ["run_created_event_id", "TEXT"],
      ["turn_started_event_id", "TEXT"],
      ["user_message_completed_event_id", "TEXT"],
    ] as const;
    if (columns.length !== expected.length || columns.some((column, index) =>
      column.name !== expected[index]?.[0] || column.type.toUpperCase() !== expected[index]?.[1])) {
      throw corruptStore("Local turn admission index schema is incompatible");
    }
    const indexes = this.database.pragma("index_list(turn_admissions)") as { name: string; unique: number; partial: number }[];
    const actual = indexes.map((index) => {
      const escaped = index.name.replaceAll("'", "''");
      const indexedColumns = this.database.pragma(`index_info('${escaped}')`) as { name: string | null }[];
      return {
        unique: Boolean(index.unique),
        partial: index.partial,
        columns: indexedColumns.map(({ name }) => name ?? ""),
      };
    });
    const primaryKey = columns.filter(({ pk }) => pk > 0).sort((a, b) => a.pk - b.pk).map(({ name }) => name);
    const expectedIndexes = [
      "workspace_id,thread_id,idempotency_key",
      "run_id",
      "turn_id",
      "run_created_event_id",
      "turn_started_event_id",
      "user_message_completed_event_id",
    ];
    if (primaryKey.join(",") !== expectedIndexes[0]
      || actual.length !== expectedIndexes.length
      || actual.some((index) => !index.unique || index.partial !== 0)
      || expectedIndexes.some((expectedIndex) => !actual.some((index) => index.columns.join(",") === expectedIndex))) {
      throw corruptStore("Local turn admission index constraints are incomplete");
    }
  }

  private assertRequiredTableKeys(): void {
    const metadata = this.database.pragma("table_info(metadata)") as { name: string; type: string; pk: number }[];
    const events = this.database.pragma("table_info(events)") as { name: string; type: string; pk: number }[];
    const grants = this.database.pragma("table_info(workspace_grant)") as { name: string; type: string; pk: number }[];
    const metadataKey = metadata.find(({ name }) => name === "key");
    const eventOrder = events.find(({ name }) => name === "insertion_order");
    const grantId = grants.find(({ name }) => name === "id");
    const eventIndexes = this.database.pragma("index_list(events)") as { origin: string }[];
    const grantIndexes = this.database.pragma("index_list(workspace_grant)") as { origin: string }[];
    if (metadataKey?.type.toUpperCase() !== "TEXT" || metadataKey.pk !== 1
      || metadata.filter(({ pk }) => pk > 0).length !== 1
      || eventOrder?.type.toUpperCase() !== "INTEGER" || eventOrder.pk !== 1
      || events.filter(({ pk }) => pk > 0).length !== 1
      || grantId?.type.toUpperCase() !== "INTEGER" || grantId.pk !== 1
      || grants.filter(({ pk }) => pk > 0).length !== 1
      || eventIndexes.some(({ origin }) => origin === "pk")
      || grantIndexes.some(({ origin }) => origin === "pk")) {
      throw corruptStore("Local database primary keys are incompatible");
    }
  }

  private assertRecoveryEvidenceBeforeOpen(databasePath: string, databaseExists: boolean): void {
    if (!databaseExists && this.hasArchivedMigrationEvidence()) {
      throw corruptStore("Local database is missing while migration evidence exists");
    }
    if (databaseExists && this.hasArchivedMigrationEvidence() && statSync(databasePath).size === 0) {
      throw corruptStore("Archived migration evidence has no valid matching database");
    }
    if (!existsSync(databasePath) && ["-wal", "-shm", "-journal"].some((suffix) => existsSync(`${databasePath}${suffix}`))) {
      throw corruptStore("Local database is missing while SQLite recovery files exist");
    }
  }

  private assertArchiveMarkerInOpenDatabase(): void {
    if (!this.hasArchivedMigrationEvidence()) return;
    try {
      const version = this.database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
      const marker = this.database.prepare("SELECT value FROM metadata WHERE key = 'legacy_migration_complete'").get() as { value: string } | undefined;
      if (!version || ![String(PRE_ADMISSION_SCHEMA_VERSION), String(SCHEMA_VERSION)].includes(version.value)
        || marker?.value !== "1") {
        throw new Error("missing migration marker");
      }
    } catch {
      throw corruptStore("Archived migration evidence has no valid matching database");
    }
  }

  private validateExistingDatabaseBeforeMutation(): void {
    const check = this.database.pragma("quick_check") as { quick_check: string }[];
    if (check.length !== 1 || check[0]?.quick_check !== "ok") {
      throw corruptStore("Local database integrity check failed");
    }
    const tables = this.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as { name: string }[];
    if (tables.length === 0) return;
    const present = new Set(tables.map(({ name }) => name));
    if (!present.has("metadata") || !present.has("events") || !present.has("workspace_grant")) {
      throw corruptStore("Local database schema is incomplete");
    }
    const version = this.database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (version && ![String(PRE_ADMISSION_SCHEMA_VERSION), String(SCHEMA_VERSION)].includes(version.value)) {
      throw corruptStore("Local database schema version is unsupported");
    }
    this.assertRequiredIndexes();
    this.validateProviderSelectionMetadata();
    const marker = this.database.prepare("SELECT value FROM metadata WHERE key = 'legacy_migration_complete'").get() as { value: string } | undefined;
    if (marker) {
      if (marker.value !== "1" || !version || ![String(PRE_ADMISSION_SCHEMA_VERSION), String(SCHEMA_VERSION)].includes(version.value)) {
        throw corruptStore("Local database metadata is invalid");
      }
      this.validateDatabase(Number(version.value));
      return;
    }
    const records = this.database.prepare("SELECT 1 FROM events UNION ALL SELECT 1 FROM workspace_grant LIMIT 1").get();
    if (records) throw corruptStore("Local database is populated without a migration marker");
  }

  private hasArchivedMigrationEvidence(): boolean {
    const archived = join(this.storageDirectory, "legacy");
    return existsSync(join(archived, "thread-events.json")) || existsSync(join(archived, "workspace-grant.json"));
  }

  private archiveLegacyFilesAfterCommit(): void {
    const sourceNames = ["thread-events.json", "workspace-grant.json"];
    const archiveDirectory = join(this.storageDirectory, "legacy");
    for (const name of sourceNames) {
      const sourcePath = join(this.storageDirectory, name);
      const archivePath = join(archiveDirectory, name);
      if (!existsSync(sourcePath)) continue;
      mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
      if (existsSync(archivePath)) {
        const sourceBytes = readFileSync(sourcePath);
        const archiveBytes = readFileSync(archivePath);
        if (!sourceBytes.equals(archiveBytes)) throw corruptStore("Legacy migration evidence conflicts with its archive");
        continue;
      }
      renameSync(sourcePath, archivePath);
    }
  }
}

function parseStoredPlatformEvent(json: string): PlatformEvent {
  try { return PlatformEventSchema.parse(JSON.parse(json)); }
  catch { throw corruptStore("Stored platform event is invalid"); }
}

function parseLifecycleEvent(event: unknown): LifecycleEvent {
  try { return LifecycleEventSchema.parse(event); }
  catch { throw corruptStore("Lifecycle event is invalid"); }
}

function parseStoredLifecycleEvent(json: string): LifecycleEvent {
  try { return LifecycleEventSchema.parse(JSON.parse(json)); }
  catch { throw corruptStore("Stored lifecycle event is invalid"); }
}

function platformFingerprint(event: PlatformEvent): string {
  const storeOwnedFields = new Set(["eventId", "sequence", "cursor", "createdAt"]);
  const input = Object.fromEntries(Object.entries(event).filter(([key]) => !storeOwnedFields.has(key)));
  return createStableEventFingerprint(input);
}

function parseStoredGrant(value: unknown): StoredLocalWorkspaceGrant {
  const grant = StoredGrantSchema.parse(value);
  if (!isAbsolute(grant.path) || grant.path.includes("\0")) {
    throw new Error("Workspace grant path is invalid");
  }
  return grant;
}

function isTerminal(event: LifecycleEvent): boolean {
  return event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted";
}

function validateReplayLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPLAY_LIMIT) {
    throw new EventStoreError("invalid_replay_limit", `Replay limit must be between 1 and ${MAX_REPLAY_LIMIT}`);
  }
}

function corruptStore(message: string): LocalPersistenceError {
  return new LocalPersistenceError("corrupt", message);
}

function sanitizeOpenError(error: unknown): Error {
  if (error instanceof LocalPersistenceError) return error;
  if (error instanceof EventStoreError) {
    return new LocalPersistenceError("corrupt", error.message);
  }
  return new LocalPersistenceError("unavailable", "Local persistence could not be opened safely");
}
