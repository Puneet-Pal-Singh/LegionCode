import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresTranscriptRepository } from "../sessions/PostgresTranscriptRepository.js";
import { PostgresLifecycleEventStore } from "../lifecycle-events/PostgresLifecycleEventStore.js";
import { PostgresTurnAdmissionRepository } from "./PostgresTurnAdmissionRepository.js";

// Run the production migrations and repository SQL against an isolated PostgreSQL
// engine. PGlite has gen_random_uuid built in, but does not ship pgcrypto.
const db = new PGlite();
const client: SqlClient = {
  query: executeQuery,
  transaction: (callback) => db.transaction(async (tx) => {
    const scoped: SqlClient = {
      query: async <Row extends SqlRow>(statement: string, params: readonly SqlValue[] = []) => {
        const result = await tx.query<Row>(statement, [...params]);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
      transaction: (nested) => nested(scoped),
    };
    return callback(scoped);
  }),
};
async function executeQuery<Row extends SqlRow>(statement: string, params: readonly SqlValue[] = []): Promise<SqlQueryResult<Row>> {
  const result = await db.query<Row>(statement, [...params]);
  return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
}
beforeAll(async () => {
  for (const migration of persistenceMigrations) {
    for (const statement of migration.statements) {
      if (statement.includes("CREATE EXTENSION IF NOT EXISTS pgcrypto")) continue;
      await db.exec(statement);
    }
  }
}, 30_000);
afterAll(() => db.close());

describe("durable admission and canonical append SQL", () => {
  it("rolls back prompt admission and permits the same request to retry", async () => {
    const fixture = await createFixture(client);
    const admissions = new PostgresTurnAdmissionRepository(client);
    await admissions.reserve(fixture.admission);
    const input = admissionInput(fixture, fixture.admission, "rollback");
    await db.exec(`CREATE FUNCTION fail_prompt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'prompt failure'; END; $$;
      CREATE TRIGGER fail_prompt BEFORE INSERT ON message_parts FOR EACH ROW EXECUTE FUNCTION fail_prompt();`);
    await expect(admissions.admitWithPrompt(input)).rejects.toThrow("prompt failure");
    expect(await admissions.getByTurnId(input.turnId)).toMatchObject({ state: "reserved", executionState: "pending" });
    expect((await client.query("SELECT status, active_run_id, admission_sequence, last_sequence FROM sessions WHERE id = $1", [fixture.sessionId])).rows[0]).toMatchObject({ status: "idle", active_run_id: null, admission_sequence: 0, last_sequence: 0 });
    expect((await client.query("SELECT id FROM runs WHERE id = $1", [input.runId])).rows).toEqual([]);
    await db.exec("DROP TRIGGER fail_prompt ON message_parts; DROP FUNCTION fail_prompt();");
    const accepted = await admissions.admitWithPrompt(input);
    const repeated = await admissions.admitWithPrompt(input);
    expect(repeated.promptMessageId).toBe(accepted.promptMessageId);
    expect(repeated.admission).toMatchObject({ state: "admitted", admissionOrder: 1 });
    await expect(admissions.admitWithPrompt({ ...input, requestFingerprint: "changed" })).rejects.toMatchObject({ code: "fingerprint_conflict" });
  });

  it("persists assistant deltas using the server-issued turn identity exactly once", async () => {
    const fixture = await createFixture(client);
    const admissions = new PostgresTurnAdmissionRepository(client);
    await admissions.reserve(fixture.admission);
    await admissions.admitWithPrompt(admissionInput(fixture, fixture.admission, "canonical"));
    const lifecycle = new PostgresLifecycleEventStore(client);
    const events = [lifecycleTurnStarted(fixture, 1), lifecycleItemStarted(fixture, 2), lifecycleDelta(fixture, 3, "final_answer"), lifecycleItemCompleted(fixture, 4), lifecycleTurnCompleted(fixture, 5)];
    await lifecycle.appendBatch(events);
    await lifecycle.appendBatch(events);
    const transcript = await new PostgresTranscriptRepository(client).listTranscript({ sessionId: fixture.sessionId, userId: fixture.userId, limit: 100 });
    expect(transcript.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(transcript.messages[1]?.parts).toHaveLength(1);
    expect(transcript.messages[1]?.parts[0]?.content).toMatchObject({ text: "x", metadata: { canonicalIdentity: { turnId: fixture.admission.turnId, runAttemptId: fixture.admission.runAttemptId }, phase: "final_answer" } });
    expect((await lifecycle.replay({ turnId: fixture.admission.turnId, afterSequence: null, limit: 100 })).events).toEqual(events);
    expect(await admissions.getByTurnId(fixture.admission.turnId)).toMatchObject({ executionState: "settled" });
    expect((await client.query("SELECT status FROM runs WHERE id = $1", [fixture.admission.runId])).rows[0]?.status).toBe("completed");
    expect((await client.query("SELECT status FROM sessions WHERE id = $1", [fixture.sessionId])).rows[0]?.status).toBe("completed");
  });

  it("appends assistant turns for distinct user turns on the same run", async () => {
    const fixture = await createFixture(client);
    const admissions = new PostgresTurnAdmissionRepository(client);
    const store = new PostgresLifecycleEventStore(client);
    await admissions.reserve(fixture.admission);
    await admissions.admitWithPrompt(admissionInput(fixture, fixture.admission, "first"));
    await store.appendBatch([lifecycleTurnStarted(fixture, 1), lifecycleItemStarted(fixture, 2), lifecycleDelta(fixture, 3, "final_answer"), lifecycleItemCompleted(fixture, 4), lifecycleTurnCompleted(fixture, 5)]);
    const next = { ...fixture, admission: { ...fixture.admission, clientMessageId: "next-client", turnId: `trn_${randomUUID().replaceAll("-", "")}`, runAttemptId: `attempt_${randomUUID().replaceAll("-", "")}` } };
    await admissions.reserve(next.admission);
    await admissions.admitWithPrompt(admissionInput(next, next.admission, "next"));
    // Retrying an old terminal event cannot settle the newer active turn.
    const oldTerminal = (await store.replay({ turnId: fixture.admission.turnId, afterSequence: 4, limit: 1 })).events[0]!;
    await store.append(oldTerminal);
    expect((await client.query("SELECT status, current_turn_id FROM sessions WHERE id = $1", [fixture.sessionId])).rows[0]).toMatchObject({ status: "running", current_turn_id: next.admission.turnId });
    await store.appendBatch([lifecycleTurnStarted(next, 1), lifecycleItemStarted(next, 2), lifecycleDelta(next, 3, "final_answer")]);
    const transcript = await new PostgresTranscriptRepository(client).listTranscript({ sessionId: fixture.sessionId, userId: fixture.userId, limit: 100 });
    expect(transcript.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(transcript.messages[1]?.id).not.toBe(transcript.messages[3]?.id);
  });

  it("isolates owners and allows only one execution claim for an admitted turn", async () => {
    const fixture = await createFixture(client);
    const admissions = new PostgresTurnAdmissionRepository(client);
    await expect(admissions.reserve({ ...fixture.admission, userId: randomUUID() })).rejects.toMatchObject({ code: "session_not_found" });
    await admissions.reserve(fixture.admission);
    await admissions.admitWithPrompt(admissionInput(fixture, fixture.admission, "claim"));
    const claim = { ...fixture.admission, claimId: "claim-first" };
    expect((await admissions.claimExecution(claim)).status).toBe("claimed");
    expect((await admissions.claimExecution({ ...claim, claimId: "claim-second" })).status).toBe("already_claimed");
    expect((await admissions.claimExecution({ ...claim, userId: randomUUID() })).status).toBe("conflict");
    expect(await admissions.markRecoveryRequired({ turnId: claim.turnId, claimId: "claim-second" })).toBe(false);
    expect(await admissions.markRecoveryRequired({ turnId: claim.turnId, claimId: "claim-first" })).toBe(true);
    expect((await admissions.claimExecution({ ...claim, claimId: "claim-retry" })).status).toBe("recovery_required");
  });

  it.each([
    { type: "turn.interrupted", payload: { outcome: { status: "interrupted", reason: "user_cancelled" } }, run: "cancelled", session: "paused" },
    { type: "turn.failed", payload: { outcome: { status: "failed", failure: { code: "internal_error", message: "fixture failure", retryable: false, correlationId: null, details: null } } }, run: "failed", session: "failed" },
  ])("settles $type from the canonical append", async ({ type, payload, run, session }) => {
    const fixture = await createFixture(client);
    const admissions = new PostgresTurnAdmissionRepository(client);
    await admissions.reserve(fixture.admission);
    await admissions.admitWithPrompt(admissionInput(fixture, fixture.admission, type));
    const terminal = { ...lifecycleEnvelope(fixture, 2), type, payload } as LifecycleEvent;
    await new PostgresLifecycleEventStore(client).appendBatch([lifecycleTurnStarted(fixture, 1), terminal]);
    expect(await admissions.getByTurnId(fixture.admission.turnId)).toMatchObject({ executionState: "settled" });
    expect((await client.query("SELECT status FROM runs WHERE id = $1", [fixture.admission.runId])).rows[0]?.status).toBe(run);
    expect((await client.query("SELECT status FROM sessions WHERE id = $1", [fixture.sessionId])).rows[0]?.status).toBe(session);
  });

  it("rolls back lifecycle events when canonical transcript projection fails", async () => {
    const fixture = await createFixture(client);
    const admissions = new PostgresTurnAdmissionRepository(client);
    await admissions.reserve(fixture.admission);
    await admissions.admitWithPrompt(admissionInput(fixture, fixture.admission, "projection"));
    await db.exec(`CREATE FUNCTION fail_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.canonical_turn_id IS NOT NULL THEN RAISE EXCEPTION 'projection failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_projection BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION fail_projection();`);
    const events = [lifecycleTurnStarted(fixture, 1), lifecycleItemStarted(fixture, 2), lifecycleDelta(fixture, 3, "final_answer")];
    const store = new PostgresLifecycleEventStore(client);
    await expect(store.appendBatch(events)).rejects.toThrow("projection failure");
    expect((await store.replay({ turnId: fixture.admission.turnId, afterSequence: null, limit: 10 })).events).toEqual([]);
    expect((await client.query("SELECT last_sequence FROM sessions WHERE id = $1", [fixture.sessionId])).rows[0]?.last_sequence).toBe(1);
    await db.exec("DROP TRIGGER fail_projection ON messages; DROP FUNCTION fail_projection();");
    await store.appendBatch(events);
    expect((await store.replay({ turnId: fixture.admission.turnId, afterSequence: null, limit: 10 })).events).toEqual(events);
  });
});

function admissionInput(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  admission: typeof fixture.admission,
  label: string,
) {
  return {
    sessionId: fixture.sessionId,
    clientMessageId: admission.clientMessageId,
    turnId: admission.turnId,
    runAttemptId: admission.runAttemptId,
    runId: admission.runId,
    requestFingerprint: `fingerprint-${label}`,
    userId: fixture.userId,
    workspaceId: fixture.workspaceId,
    taskId: fixture.taskId,
    mode: "build",
    promptMessage: {
      role: "user" as const,
      clientMessageId: admission.clientMessageId,
      dedupeKey: `prompt-${label}`,
      parts: [{ type: "text" as const, content: { text: `prompt-${label}` } }],
    },
  };
}

async function createFixture(client: SqlClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const userId = randomUUID();
  const repoId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const runId = `run_${suffix}`;
  const threadId = `thr_${suffix}`;
  const turnId = `trn_${suffix}`;
  const runAttemptId = `attempt_${suffix}`;
  const clientMessageId = `client-${suffix}`;

  await client.query("INSERT INTO users (id, display_name) VALUES ($1, $2)", [userId, "durability-test"]);
  await client.query(
    "INSERT INTO repos (id, provider, owner, name, full_name, repo_url, default_branch) VALUES ($1, 'test', 'codex', $2, $3, 'https://invalid.test/repo', 'main')",
    [repoId, `repo-${suffix}`, `codex/repo-${suffix}`],
  );
  await client.query(
    "INSERT INTO workspaces (id, user_id, repo_id, name, default_branch, last_selected_branch) VALUES ($1, $2, $3, $4, 'main', 'main')",
    [workspaceId, userId, repoId, `workspace-${suffix}`],
  );
  await new PostgresTranscriptRepository(client).ensureSession({
    sessionId,
    userId,
    workspaceId,
    taskId,
    title: "durability fixture",
    threadId: null,
    activeRunId: null,
    status: "idle",
  });
  return {
    userId,
    repoName: `repo-${suffix}`,
    workspaceId,
    taskId,
    sessionId,
    admission: {
      sessionId,
      userId,
      workspaceId,
      clientMessageId,
      threadId,
      turnId,
      runAttemptId,
      runId,
    },
  };
}

function lifecycleDelta(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
  phase: "commentary" | "final_answer",
): LifecycleEvent {
  const suffix = randomUUID().replaceAll("-", "");
  return {
    eventId: `evt_${suffix}`,
    threadId: fixture.admission.threadId,
    turnId: fixture.admission.turnId,
    runAttemptId: fixture.admission.runAttemptId,
    itemId: `itm_${fixture.admission.turnId.slice(4)}`,
    sequence,
    idempotencyKey: `durability-fixture:${sequence}`,
    producer: { kind: "runtime_kernel", id: "chat-durability-postgres-test" },
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence % 60)).toISOString(),
    type: "assistant_message.delta",
    payload: { kind: "assistant_message", phase, delta: "x" },
  } as LifecycleEvent;
}

function lifecycleItemStarted(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
): LifecycleEvent {
  return {
    ...lifecycleEnvelope(fixture, sequence),
    itemId: `itm_${fixture.admission.turnId.slice(4)}`,
    type: "item.started",
    payload: { kind: "assistant_message" },
  } as LifecycleEvent;
}

function lifecycleItemCompleted(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
): LifecycleEvent {
  return {
    ...lifecycleEnvelope(fixture, sequence),
    itemId: `itm_${fixture.admission.turnId.slice(4)}`,
    type: "item.completed",
    payload: { result: {} },
  } as LifecycleEvent;
}

function lifecycleEnvelope(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
) {
  return {
    eventId: `evt_${randomUUID().replaceAll("-", "")}`,
    threadId: fixture.admission.threadId,
    turnId: fixture.admission.turnId,
    runAttemptId: fixture.admission.runAttemptId,
    sequence,
    idempotencyKey: `durability-fixture:${sequence}`,
    producer: { kind: "runtime_kernel", id: "chat-durability-postgres-test" },
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence % 60)).toISOString(),
  };
}

function lifecycleTurnStarted(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
): LifecycleEvent {
  const suffix = randomUUID().replaceAll("-", "");
  return {
    eventId: `evt_${suffix}`,
    threadId: fixture.admission.threadId,
    turnId: fixture.admission.turnId,
    runAttemptId: fixture.admission.runAttemptId,
    sequence,
    idempotencyKey: `durability-fixture:${sequence}`,
    producer: { kind: "runtime_kernel", id: "chat-durability-postgres-test" },
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    type: "turn.started",
    payload: {},
  } as LifecycleEvent;
}

function lifecycleTurnCompleted(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
): LifecycleEvent {
  const suffix = randomUUID().replaceAll("-", "");
  return {
    eventId: `evt_${suffix}`,
    threadId: fixture.admission.threadId,
    turnId: fixture.admission.turnId,
    runAttemptId: fixture.admission.runAttemptId,
    sequence,
    idempotencyKey: `durability-fixture:${sequence}`,
    producer: { kind: "runtime_kernel", id: "chat-durability-postgres-test" },
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    type: "turn.completed",
    payload: { outcome: { status: "completed" } },
  } as LifecycleEvent;
}

