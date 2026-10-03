import { registerEventStoreConformance } from "@repo/contract-conformance";
import {
  EVENT_SCHEMA_VERSION,
  EventCursorSchema,
  EventIdSchema,
  PlatformEventSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type PlatformEvent,
} from "@repo/platform-protocol";
import { LifecycleEventSchema } from "@repo/platform-protocol/lifecycle";
import { afterAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPersistence } from "./local.js";
import { LocalPersistenceError } from "./errors.js";
import { createStableEventFingerprint } from "./fingerprint.js";
import type { AppendEventInput } from "./types.js";

const stores: LocalPersistence[] = [];
const directories: string[] = [];

registerEventStoreConformance("LocalPersistence", () => createPersistence().events);

afterAll(() => {
  for (const store of stores) store.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("LocalPersistence", () => {
  it("reopens canonical Thread events and accepts a retry despite schema defaults", async () => {
    const persistence = createPersistence();
    const input = createThreadInput("thread:defaulted");
    const first = await persistence.events.append(input);
    persistence.close();

    const reopened = openPersistence(persistenceDirectory(persistence));
    await expect(reopened.events.append(input)).resolves.toEqual(first);
    await expect(reopened.events.listAll()).resolves.toEqual([first]);
  });

  it("rolls back a valid first append when a later batch event is malformed", async () => {
    const persistence = createPersistence();
    const invalid = { ...createThreadInput("bad"), type: "unknown.event" } as unknown as AppendEventInput;

    await expect(persistence.events.appendBatch([createThreadInput("valid-first"), invalid]))
      .rejects.toThrow();
    await expect(persistence.events.listAll()).resolves.toEqual([]);
  });

  it("preserves the complete lifecycle envelope and enforces raw port settlement rules", async () => {
    const persistence = createPersistence();
    const queued = lifecycle(1, "turn.queued");
    const started = lifecycle(2, "turn.started");
    await expect(persistence.lifecycleEvents.appendBatch([queued, started])).resolves.toEqual([queued, started]);
    await expect(persistence.lifecycleEvents.replay({ turnId: queued.turnId, afterSequence: null, limit: 10 }))
      .resolves.toMatchObject({ events: [queued, started], nextSequence: 2 });
    await expect(persistence.lifecycleEvents.append(lifecycle(4, "turn.started")))
      .rejects.toMatchObject({ code: "sequence_gap" });
    const terminal = lifecycle(3, "turn.completed");
    await persistence.lifecycleEvents.append(terminal);
    await expect(persistence.lifecycleEvents.append(lifecycle(4, "turn.started")))
      .rejects.toMatchObject({ code: "terminal_stream" });
  });

  it("retries lifecycle envelopes exactly after restart and rolls back a bad batch", async () => {
    const persistence = createPersistence();
    const queued = lifecycle(1, "turn.queued");
    await persistence.lifecycleEvents.append(queued);
    const directory = persistenceDirectory(persistence);
    persistence.close();

    const reopened = openPersistence(directory);
    await expect(reopened.lifecycleEvents.append(queued)).resolves.toEqual(queued);
    await expect(reopened.lifecycleEvents.append({ ...queued, producer: { kind: "runtime_kernel", id: "changed" } }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    const fresh = createPersistence();
    await expect(fresh.lifecycleEvents.appendBatch([lifecycle(1, "turn.queued"), lifecycle(3, "turn.started")]))
      .rejects.toMatchObject({ code: "sequence_gap" });
    await expect(fresh.lifecycleEvents.replay({ turnId: queued.turnId, afterSequence: null, limit: 10 }))
      .resolves.toMatchObject({ events: [], nextSequence: null });
  });

  it("migrates legacy Thread and grant data once, then keeps revocation durable", async () => {
    const directory = makeDirectory();
    const originalEvent = createLegacyThreadEvent();
    const grant = {
      version: 1 as const,
      path: directory,
      grant: {
        workspaceId: WorkspaceIdSchema.parse("wrk_legacygrant"),
        displayName: "Legacy workspace",
        repositoryIdentity: "git:legacy:repo",
        branch: "main",
        readiness: "ready" as const,
        capabilities: ["filesystem", "git"],
        reason: null,
        grantedAt: "2026-06-15T00:00:00.000Z",
      },
    };
    const eventBytes = JSON.stringify({ version: 1, events: [originalEvent] });
    const grantBytes = JSON.stringify(grant);
    writeFileSync(join(directory, "thread-events.json"), eventBytes);
    writeFileSync(join(directory, "workspace-grant.json"), grantBytes);

    const persistence = openPersistence(directory);
    await expect(persistence.events.listAll()).resolves.toEqual([originalEvent]);
    await expect(persistence.workspaceGrants.read()).resolves.toEqual(grant);
    expect(readFileSync(join(directory, "legacy", "thread-events.json"), "utf8")).toBe(eventBytes);
    expect(readFileSync(join(directory, "legacy", "workspace-grant.json"), "utf8")).toBe(grantBytes);

    await persistence.workspaceGrants.clear();
    persistence.close();
    const reopened = openPersistence(directory);
    await expect(reopened.workspaceGrants.read()).resolves.toBeNull();
    await expect(reopened.events.append(createThreadInput("next-event"))).resolves.toMatchObject({ sequence: 2 });
  });

  it("fails closed on archived evidence without a valid database and preserves it", () => {
    const directory = makeDirectory();
    const evidence = "{\"version\":1,\"events\":[]}";
    const archiveDirectory = join(directory, "legacy");
    mkdirSync(archiveDirectory);
    writeFileSync(join(archiveDirectory, "thread-events.json"), evidence);
    expect(() => openPersistence(directory)).toThrow(LocalPersistenceError);
    expect(readFileSync(join(archiveDirectory, "thread-events.json"), "utf8")).toBe(evidence);
    expect(() => readFileSync(join(directory, "local-events.sqlite"))).toThrow();
  });

  it("rejects corrupt SQLite without replacing its bytes", () => {
    const directory = makeDirectory();
    const bytes = Buffer.from("not a SQLite database");
    writeFileSync(join(directory, "local-events.sqlite"), bytes);
    expect(() => openPersistence(directory)).toThrow(LocalPersistenceError);
    expect(readFileSync(join(directory, "local-events.sqlite"))).toEqual(bytes);
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["unsupported legacy version", JSON.stringify({ version: 2, events: [] })],
  ])("preserves %s legacy input and refuses partial migration", (_name, raw) => {
    const directory = makeDirectory();
    writeFileSync(join(directory, "thread-events.json"), raw);
    const grant = JSON.stringify({ version: 1, path: directory, grant: { malformed: true } });
    writeFileSync(join(directory, "workspace-grant.json"), grant);
    expect(() => openPersistence(directory)).toThrow(LocalPersistenceError);
    expect(readFileSync(join(directory, "thread-events.json"), "utf8")).toBe(raw);
    expect(readFileSync(join(directory, "workspace-grant.json"), "utf8")).toBe(grant);
    const db = new Database(join(directory, "local-events.sqlite"), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT value FROM metadata WHERE key = 'legacy_migration_complete'").get()).toBeUndefined();
    db.close();
  });

  it("rejects a semantic SQLite index mismatch without rebuilding it", async () => {
    const persistence = createPersistence();
    await persistence.events.append(createThreadInput("semantic"));
    const databasePath = join(persistenceDirectory(persistence), "local-events.sqlite");
    persistence.close();
    const database = new Database(databasePath);
    database.prepare("UPDATE events SET sequence = 9 WHERE family = 'platform'").run();
    database.close();
    expect(() => openPersistence(persistenceDirectory(persistence))).toThrow(LocalPersistenceError);
    const check = new Database(databasePath, { readonly: true });
    expect(check.prepare("SELECT sequence FROM events WHERE family = 'platform'").get()).toMatchObject({ sequence: 9 });
    check.close();
  });

  it("preserves unsupported database bytes before any journal-mode migration", () => {
    const persistence = createPersistence();
    const databasePath = join(persistenceDirectory(persistence), "local-events.sqlite");
    persistence.close();
    const database = new Database(databasePath);
    database.prepare("UPDATE metadata SET value = '2' WHERE key = 'schema_version'").run();
    database.close();
    const bytes = readFileSync(databasePath);
    expect(() => openPersistence(persistenceDirectory(persistence))).toThrow(LocalPersistenceError);
    expect(readFileSync(databasePath)).toEqual(bytes);
  });

  it("refuses incompatible primary keys and missing uniqueness constraints without rebuilding", () => {
    const directory = makeDirectory();
    const databasePath = join(directory, "local-events.sqlite");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE events(
        insertion_order INTEGER PRIMARY KEY AUTOINCREMENT, family TEXT NOT NULL,
        event_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT,
        stream_type TEXT NOT NULL, stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        cursor TEXT, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, event_json TEXT NOT NULL
      );
      CREATE TABLE workspace_grant(id INTEGER NOT NULL UNIQUE, value_json TEXT NOT NULL);
      CREATE INDEX events_family_order ON events(family, insertion_order);
      CREATE INDEX events_stream_order ON events(family, stream_type, stream_id, sequence);
      INSERT INTO metadata VALUES ('schema_version', '1');
      INSERT INTO metadata VALUES ('legacy_migration_complete', '1');
    `);
    database.close();
    const bytes = readFileSync(databasePath);
    expect(() => openPersistence(directory)).toThrow(LocalPersistenceError);
    expect(readFileSync(databasePath)).toEqual(bytes);
  });

  it("rejects unexpected persisted workspace-grant row identities", () => {
    const persistence = createPersistence();
    const databasePath = join(persistenceDirectory(persistence), "local-events.sqlite");
    persistence.close();
    const database = new Database(databasePath);
    database.pragma("ignore_check_constraints = ON");
    database.prepare("INSERT INTO workspace_grant(id, value_json) VALUES (2, ?)")
      .run(JSON.stringify({ version: 1, path: "/tmp/other", grant: {} }));
    database.close();
    expect(() => openPersistence(persistenceDirectory(persistence))).toThrow(LocalPersistenceError);
  });

  it("rejects a zero-byte database beside archived migration evidence", () => {
    const directory = makeDirectory();
    const archiveDirectory = join(directory, "legacy");
    mkdirSync(archiveDirectory);
    const evidence = "legacy bytes";
    writeFileSync(join(archiveDirectory, "workspace-grant.json"), evidence);
    writeFileSync(join(directory, "local-events.sqlite"), "");
    expect(() => openPersistence(directory)).toThrow(LocalPersistenceError);
    expect(readFileSync(join(archiveDirectory, "workspace-grant.json"), "utf8")).toBe(evidence);
    expect(readFileSync(join(directory, "local-events.sqlite"))).toHaveLength(0);
  });

  it("finishes archiving after a committed migration without reimporting late legacy files", async () => {
    const directory = makeDirectory();
    const initial = openPersistence(directory);
    initial.close();
    const lateLegacy = JSON.stringify({ version: 1, events: [createLegacyThreadEvent()] });
    writeFileSync(join(directory, "thread-events.json"), lateLegacy);

    const recovered = openPersistence(directory);
    await expect(recovered.events.listAll()).resolves.toEqual([]);
    expect(readFileSync(join(directory, "legacy", "thread-events.json"), "utf8")).toBe(lateLegacy);
  });

  it("returns a typed unavailable error after close instead of leaking SQLite errors", async () => {
    const persistence = createPersistence();
    persistence.close();
    await expect(persistence.events.listAll()).rejects.toBeInstanceOf(LocalPersistenceError);
  });

  it("creates the database file with owner-only permissions", () => {
    const persistence = createPersistence();
    const databasePath = join(persistenceDirectory(persistence), "local-events.sqlite");
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it("rejects legacy duplicate identities and sequence gaps atomically", () => {
    const duplicateDirectory = makeDirectory();
    const first = createLegacyThreadEvent();
    if (first.type !== "thread.created") throw new Error("Expected a thread creation event");
    const duplicate = PlatformEventSchema.parse({
      ...first,
      threadId: "thr_legacyother",
      scopeId: "thr_legacyother",
      payload: { thread: { ...first.payload.thread, id: "thr_legacyother" } },
      cursor: "cursor_legacyother001",
    });
    const duplicateBytes = JSON.stringify({ version: 1, events: [first, duplicate] });
    writeFileSync(join(duplicateDirectory, "thread-events.json"), duplicateBytes);
    expect(() => openPersistence(duplicateDirectory)).toThrow(LocalPersistenceError);
    expect(readFileSync(join(duplicateDirectory, "thread-events.json"), "utf8")).toBe(duplicateBytes);

    const gapDirectory = makeDirectory();
    const gap = PlatformEventSchema.parse({
      ...first,
      eventId: "evt_legacythread002",
      cursor: "cursor_legacythread002",
      sequence: 3,
      idempotencyKey: "legacy:gap",
    });
    const gapBytes = JSON.stringify({ version: 1, events: [first, gap] });
    writeFileSync(join(gapDirectory, "thread-events.json"), gapBytes);
    expect(() => openPersistence(gapDirectory)).toThrow(LocalPersistenceError);
    expect(readFileSync(join(gapDirectory, "thread-events.json"), "utf8")).toBe(gapBytes);
  });

  it("rejects generated event ID and cursor collisions without advancing stream state", async () => {
    let generatedId = 0;
    const idDirectory = makeDirectory();
    const idStore = new LocalPersistence({
      storageDirectory: idDirectory,
      idGenerator: {
        nextEventId: () => EventIdSchema.parse(generatedId++ < 2 ? "evt_collisionid001" : "evt_collisionid003"),
        nextCursor: () => EventCursorSchema.parse(`cursor_collisionid${String(generatedId).padStart(3, "0")}`),
      },
    });
    await idStore.events.append(createThreadInput("id:first", "thr_collisionone"));
    await expect(idStore.events.append(createThreadInput("id:second", "thr_collisiontwo")))
      .rejects.toMatchObject({ code: "event_id_conflict" });
    await expect(idStore.events.replay({
      scope: { scopeType: "thread", scopeId: ThreadIdSchema.parse("thr_collisiontwo") }, afterCursor: null, limit: 10,
    })).resolves.toMatchObject({ events: [] });

    let cursorId = 0;
    const cursorStore = new LocalPersistence({
      storageDirectory: makeDirectory(),
      idGenerator: {
        nextEventId: () => EventIdSchema.parse(`evt_cursorcollision${String(++cursorId).padStart(3, "0")}`),
        nextCursor: () => EventCursorSchema.parse("cursor_cursorcollision001"),
      },
    });
    await cursorStore.events.append(createThreadInput("cursor:first", "thr_cursorone"));
    await expect(cursorStore.events.append(createThreadInput("cursor:second", "thr_cursortwo")))
      .rejects.toMatchObject({ code: "cursor_conflict" });
    await expect(cursorStore.events.replay({
      scope: { scopeType: "thread", scopeId: ThreadIdSchema.parse("thr_cursortwo") }, afterCursor: null, limit: 10,
    })).resolves.toMatchObject({ events: [] });
  });

  it("rejects a lifecycle event ID reused by another turn", async () => {
    const persistence = createPersistence();
    await persistence.lifecycleEvents.append(lifecycle(1, "turn.queued"));
    const reused = LifecycleEventSchema.parse({
      ...lifecycle(1, "turn.queued"),
      threadId: ThreadIdSchema.parse("thr_lifecycleother"),
      turnId: "trn_lifecycleother",
    });
    await expect(persistence.lifecycleEvents.append(reused)).rejects.toMatchObject({ code: "event_id_conflict" });
    await expect(persistence.lifecycleEvents.replay({
      turnId: reused.turnId, afterSequence: null, limit: 10,
    })).resolves.toMatchObject({ events: [] });
  });

  it("rejects a second process while the writer lives and releases the lock after a crash", async () => {
    const directory = makeDirectory();
    const databasePath = join(directory, "local-events.sqlite");
    const initial = openPersistence(directory);
    const committed = await initial.events.append(createThreadInput("before-crash"));
    if (committed.type !== "thread.created") throw new Error("Expected a Thread creation event");
    const interrupted = PlatformEventSchema.parse({
      ...committed,
      eventId: "evt_crashuncommitted",
      cursor: "cursor_crashuncommitted",
      threadId: "thr_crashsecond",
      scopeId: "thr_crashsecond",
      idempotencyKey: "crash:uncommitted",
      payload: { thread: { ...committed.payload.thread, id: "thr_crashsecond" } },
    });
    const fingerprintInput = Object.fromEntries(Object.entries(interrupted)
      .filter(([key]) => !["eventId", "sequence", "cursor", "createdAt"].includes(key)));
    const fingerprint = createStableEventFingerprint(fingerprintInput);
    const contenderCode = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1], { timeout: 0 });
      db.pragma('busy_timeout = 0');
      db.pragma('journal_mode = WAL');
      db.pragma('locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
      db.prepare("UPDATE metadata SET value = '2' WHERE key = 'schema_version'").run();
      db.exec('COMMIT');
      db.close();
    `;
    const appContender = spawnSync(process.execPath, ["-e", contenderCode, databasePath], {
      cwd: process.cwd(), encoding: "utf8", timeout: 5_000,
    });
    expect(appContender.status).not.toBe(0);
    initial.close();
    const childCode = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1], { timeout: 0 });
      db.pragma('busy_timeout = 0');
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
      const event = JSON.parse(process.argv[2]);
      db.prepare("INSERT INTO events(family, event_id, thread_id, turn_id, stream_type, stream_id, sequence, cursor, idempotency_key, fingerprint, event_json) VALUES ('platform', @eventId, @threadId, NULL, @streamType, @streamId, @sequence, @cursor, @idempotencyKey, @fingerprint, @eventJson)")
        .run({ eventId: event.eventId, threadId: event.threadId, streamType: event.scopeType,
          streamId: event.scopeId, sequence: event.sequence, cursor: event.cursor,
          idempotencyKey: event.idempotencyKey, fingerprint: process.argv[3], eventJson: JSON.stringify(event) });
      process.stdout.write('LOCKED\\n');
      setInterval(() => {}, 1000);
    `;
    const owner = spawn(process.execPath, ["-e", childCode, databasePath, JSON.stringify(interrupted), fingerprint], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    owner.stdout.setEncoding("utf8");
    owner.stdout.on("data", (chunk: string) => { output += chunk; });
    try {
      await new Promise<void>((resolve, reject) => {
        const onData = () => {
          if (output.includes("LOCKED")) {
            clearTimeout(timeout);
            owner.stdout.off("data", onData);
            owner.off("exit", onExit);
            resolve();
          }
        };
        const onExit = (code: number | null) => {
          clearTimeout(timeout);
          owner.stdout.off("data", onData);
          reject(new Error(`Lock owner exited before readiness: ${code}`));
        };
        const timeout = setTimeout(() => {
          owner.stdout.off("data", onData);
          owner.off("exit", onExit);
          reject(new Error("Lock owner did not become ready"));
        }, 5_000);
        owner.stdout.on("data", onData);
        owner.once("error", reject);
        owner.once("exit", onExit);
      });
      const contender = spawnSync(process.execPath, ["-e", contenderCode, databasePath], {
        cwd: process.cwd(), encoding: "utf8", timeout: 5_000,
      });
      expect(contender.status).not.toBe(0);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGKILL");
        await once(owner, "exit");
      }
    }
    const recovered = openPersistence(directory);
    await expect(recovered.events.listAll()).resolves.toEqual([committed]);
    recovered.close();

    const afterCommit = PlatformEventSchema.parse({
      ...createThreadInput("after-commit-crash", "thr_aftercommit"),
      eventId: EventIdSchema.parse("evt_aftercommit001"),
      cursor: EventCursorSchema.parse("cursor_aftercommit001"),
      sequence: 1,
      createdAt: "2026-06-15T00:00:00.000Z",
    });
    const afterCommitFingerprint = createStableEventFingerprint(Object.fromEntries(Object.entries(afterCommit)
      .filter(([key]) => !["eventId", "sequence", "cursor", "createdAt"].includes(key))));
    const commitThenCrashCode = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1]);
      db.pragma('synchronous = FULL');
      db.exec('BEGIN IMMEDIATE');
      const event = JSON.parse(process.argv[2]);
      db.prepare("INSERT INTO events(family, event_id, thread_id, turn_id, stream_type, stream_id, sequence, cursor, idempotency_key, fingerprint, event_json) VALUES ('platform', @eventId, @threadId, NULL, @streamType, @streamId, @sequence, @cursor, @idempotencyKey, @fingerprint, @eventJson)")
        .run({ eventId: event.eventId, threadId: event.threadId, streamType: event.scopeType,
          streamId: event.scopeId, sequence: event.sequence, cursor: event.cursor,
          idempotencyKey: event.idempotencyKey, fingerprint: process.argv[3], eventJson: JSON.stringify(event) });
      db.exec('COMMIT');
      process.kill(process.pid, 'SIGKILL');
    `;
    const committedOwner = spawnSync(process.execPath, ["-e", commitThenCrashCode, databasePath,
      JSON.stringify(afterCommit), afterCommitFingerprint], { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 });
    expect(committedOwner.signal).toBe("SIGKILL");
    const afterRecovery = openPersistence(directory);
    await expect(afterRecovery.events.listAll()).resolves.toEqual([committed, afterCommit]);
  });
});

const directoryByStore = new WeakMap<LocalPersistence, string>();

function createPersistence(): LocalPersistence {
  const directory = makeDirectory();
  return openPersistence(directory);
}

function openPersistence(directory: string): LocalPersistence {
  const store = new LocalPersistence({ storageDirectory: directory });
  stores.push(store);
  directoryByStore.set(store, directory);
  return store;
}

function persistenceDirectory(persistence: LocalPersistence): string {
  const directory = directoryByStore.get(persistence);
  if (!directory) throw new Error("Missing test storage directory");
  return directory;
}

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "legioncode-local-events-"));
  directories.push(directory);
  return directory;
}

function createThreadInput(idempotencyKey: string, rawThreadId = "thr_localpersist"): AppendEventInput {
  const threadId = ThreadIdSchema.parse(rawThreadId);
  return {
    threadId,
    workspaceId: WorkspaceIdSchema.parse("wrk_localpersist"),
    runId: null,
    scopeType: "thread",
    scopeId: threadId,
    type: "thread.created",
    payload: {
      thread: {
        id: threadId,
        userId: UserIdSchema.parse("usr_localpersist"),
        workspaceId: "wrk_localpersist",
        title: "Persistent thread",
        titleSource: "user",
        status: "active",
        pinnedAt: null,
        archivedAt: null,
        activeRunId: null,
        activeLeafItemId: null,
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z",
        lastEventSequence: 1,
      },
    },
    idempotencyKey,
    producer: { kind: "control_plane", id: "local-persistence-test" },
    schemaVersion: EVENT_SCHEMA_VERSION,
  } as AppendEventInput;
}

function createLegacyThreadEvent(): PlatformEvent {
  return PlatformEventSchema.parse({
    ...createThreadInput("legacy:thread-created"),
    eventId: "evt_legacythread001",
    sequence: 1,
    cursor: "cursor_legacythread001",
    createdAt: "2026-06-15T00:00:00.000Z",
  });
}

function lifecycle(sequence: number, type: "turn.queued" | "turn.started" | "turn.completed") {
  return LifecycleEventSchema.parse({
    eventId: `evt_localpersist${String(sequence).padStart(2, "0")}`,
    threadId: "thr_localpersist",
    turnId: "trn_localpersist",
    runAttemptId: "attempt_localpersist",
    sequence,
    idempotencyKey: `local-persistence:${sequence}`,
    producer: { kind: "runtime_kernel", id: "local-persistence-test" },
    schemaVersion: 1,
    createdAt: "2026-06-15T00:00:00.000Z",
    type,
    payload: type === "turn.completed" ? { outcome: { status: "completed" } } : {},
  });
}
