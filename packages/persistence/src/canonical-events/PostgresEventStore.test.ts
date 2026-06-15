import {
  EVENT_SCHEMA_VERSION,
  EventScopeSchema,
  PlatformEventSchema,
  type EventCursor,
  type EventId,
} from "@repo/platform-protocol";
import { EventStoreError } from "@repo/event-store";
import { registerEventStoreConformance } from "@repo/contract-conformance";
import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresEventStore } from "./PostgresEventStore.js";
import type { EventStoreIdGenerator } from "@repo/event-store";

const timestamp = "2026-06-09T12:00:00.000Z";
const clock = { now: () => timestamp };
const runScope = EventScopeSchema.parse({
  scopeType: "run",
  scopeId: "run_abc123",
});

interface CanonicalEventRow extends SqlRow {
  event_id: string;
  scope_type: string;
  scope_id: string;
  thread_id: string;
  run_id: string | null;
  workspace_id: string;
  artifact_id: string | null;
  provider_id: string | null;
  sequence: number;
  cursor: string;
  idempotency_key: string;
  event_type: string;
  payload_json: unknown;
  schema_version: number;
  producer_kind: string;
  producer_id: string | null;
  created_at: string;
}

class CanonicalEventSqlClient implements SqlClient {
  readonly queries: Array<{ statement: string; params: readonly SqlValue[] }> =
    [];
  private rows: CanonicalEventRow[] = [];
  private sequences = new Map<string, number>();

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.queries.push({ statement, params });
    if (statement.includes("INSERT INTO canonical_event_scope_sequences")) {
      this.ensureSequence(params);
      return emptyResult();
    }
    if (statement.includes("SELECT next_sequence")) {
      return rowsResult<Row>([{ next_sequence: this.readSequence(params) }]);
    }
    if (statement.includes("UPDATE canonical_event_scope_sequences")) {
      return this.advanceSequence(params);
    }
    if (statement.includes("AND idempotency_key = $3")) {
      return rowsResult<Row>(this.findByIdempotency(params));
    }
    if (statement.includes("INSERT INTO canonical_events")) {
      return rowsResult<Row>([this.insertEvent(params)]);
    }
    if (statement.includes("AND cursor = $3")) {
      return rowsResult<Row>(this.findCursor(params));
    }
    if (statement.includes("ORDER BY sequence ASC")) {
      return rowsResult<Row>(this.replay(params));
    }
    throw new Error(`Unhandled SQL: ${statement}`);
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    const rows = structuredClone(this.rows);
    const sequences = new Map(this.sequences);
    try {
      return await callback(this);
    } catch (error) {
      this.rows = rows;
      this.sequences = sequences;
      throw error;
    }
  }

  countEvents(): number {
    return this.rows.length;
  }

  readNextSequence(scopeType: string, scopeId: string): number | undefined {
    return this.sequences.get(`${scopeType}:${scopeId}`);
  }

  private ensureSequence(params: readonly SqlValue[]): void {
    const key = scopeKey(params);
    if (!this.sequences.has(key)) {
      this.sequences.set(key, 1);
    }
  }

  private readSequence(params: readonly SqlValue[]): number {
    const sequence = this.sequences.get(scopeKey(params));
    if (sequence === undefined) {
      throw new Error("Missing sequence row");
    }
    return sequence;
  }

  private advanceSequence(
    params: readonly SqlValue[],
  ): Promise<SqlQueryResult<SqlRow>> {
    const key = scopeKey(params);
    const expected = readNumberParam(params[2], "sequence");
    if (this.sequences.get(key) !== expected) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    this.sequences.set(key, expected + 1);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  private findByIdempotency(
    params: readonly SqlValue[],
  ): CanonicalEventRow[] {
    const [scopeType, scopeId, idempotencyKey] = params;
    return this.rows.filter(
      (row) =>
        row.scope_type === scopeType &&
        row.scope_id === scopeId &&
        row.idempotency_key === idempotencyKey,
    );
  }

  private insertEvent(params: readonly SqlValue[]): CanonicalEventRow {
    const row = createRow(params);
    assertNoUniqueConflict(this.rows, row);
    this.rows.push(row);
    return row;
  }

  private findCursor(params: readonly SqlValue[]): CanonicalEventRow[] {
    const [scopeType, scopeId, cursor] = params;
    return this.rows.filter(
      (row) =>
        row.scope_type === scopeType &&
        row.scope_id === scopeId &&
        row.cursor === cursor,
    );
  }

  private replay(params: readonly SqlValue[]): CanonicalEventRow[] {
    const [scopeType, scopeId, afterSequence, limit] = params;
    return this.rows
      .filter(
        (row) =>
          row.scope_type === scopeType &&
          row.scope_id === scopeId &&
          row.sequence > readNumberParam(afterSequence, "afterSequence"),
      )
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, readNumberParam(limit, "limit"));
  }
}

describe("PostgresEventStore", () => {
  it("appends and replays canonical events in scoped sequence order", async () => {
    const client = new CanonicalEventSqlClient();
    const store = createStore(client);

    const first = await store.append(createRunEventInput("run:created"));
    const second = await store.append(
      createRunEventInput("run:started", "run.started"),
    );
    const replay = await store.replay({
      scope: runScope,
      afterCursor: null,
      limit: 10,
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(replay.events).toEqual([first, second]);
    expect(replay.nextCursor).toBe(second.cursor);
    expect(client.queries.some((query) => query.statement.includes("FOR UPDATE"))).toBe(
      true,
    );
  });

  it("returns exact idempotent retries without advancing scope sequence", async () => {
    const client = new CanonicalEventSqlClient();
    const store = createStore(client);
    const input = createToolEventInput({ zeta: true, alpha: "same" });

    const first = await store.append(input);
    const retry = await store.append(
      createToolEventInput({ alpha: "same", zeta: true }),
    );
    const next = await store.append(
      createRunEventInput("run:started", "run.started"),
    );

    expect(retry).toEqual(first);
    expect(next.sequence).toBe(2);
    expect(client.readNextSequence("run", "run_abc123")).toBe(3);
  });

  it("rejects changed input with the same scoped idempotency key", async () => {
    const store = createStore(new CanonicalEventSqlClient());

    await store.append(createToolEventInput({ alpha: "same", zeta: true }));

    await expect(
      store.append(createToolEventInput({ alpha: "changed", zeta: true })),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("replays after cursor and rejects cursors outside the requested scope", async () => {
    const store = createStore(new CanonicalEventSqlClient());
    const first = await store.append(createRunEventInput("run:created"));
    const second = await store.append(
      createRunEventInput("run:started", "run.started"),
    );

    const replay = await store.replay({
      scope: runScope,
      afterCursor: first.cursor,
      limit: 1,
    });

    expect(replay.events).toEqual([second]);
    await expect(
      store.replay({
        scope: EventScopeSchema.parse({
          scopeType: "thread",
          scopeId: "thr_abc123",
        }),
        afterCursor: first.cursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "cursor_not_found" });
  });

  it("rolls back batch appends when a generated event ID conflicts", async () => {
    const client = new CanonicalEventSqlClient();
    const store = createStore(client, {
      eventIds: ["evt_duplicate1", "evt_duplicate1"],
      cursors: ["cursor_cursor001", "cursor_cursor002"],
    });

    await expect(
      store.appendBatch([
        createRunEventInput("run:created"),
        createRunEventInput("run:started", "run.started"),
      ]),
    ).rejects.toMatchObject({ code: "event_id_conflict" });

    expect(client.countEvents()).toBe(0);
  });

  it("rejects invalid replay limits with typed errors", async () => {
    const store = createStore(new CanonicalEventSqlClient());

    await expect(
      store.replay({ scope: runScope, afterCursor: null, limit: 0 }),
    ).rejects.toMatchObject({ code: "invalid_replay_limit" });
    await expect(
      store.replay({
        scope: runScope,
        afterCursor: "not-a-cursor" as EventCursor,
        limit: 1,
      }),
    ).rejects.toThrow();
  });
});

registerEventStoreConformance("PostgresEventStore", () =>
  createStore(new CanonicalEventSqlClient()),
);

function createStore(
  client: SqlClient,
  overrides: {
    eventIds?: readonly string[];
    cursors?: readonly string[];
  } = {},
): PostgresEventStore {
  return new PostgresEventStore(
    client,
    clock,
    createIdGenerator(overrides.eventIds, overrides.cursors),
  );
}

function createIdGenerator(
  eventIds: readonly string[] = [
    "evt_event001",
    "evt_event002",
    "evt_event003",
    "evt_event004",
  ],
  cursors: readonly string[] = [
    "cursor_cursor001",
    "cursor_cursor002",
    "cursor_cursor003",
    "cursor_cursor004",
  ],
): EventStoreIdGenerator {
  let eventIndex = 0;
  let cursorIndex = 0;
  return {
    nextEventId: () => eventIds[eventIndex++] as EventId,
    nextCursor: () => cursors[cursorIndex++] as EventCursor,
  };
}

function createRunEventInput(
  idempotencyKey: string,
  type: "run.created" | "run.started" = "run.created",
) {
  return toAppendInput({
    ...baseEnvelope,
    scopeType: "run",
    scopeId: "run_abc123",
    runId: "run_abc123",
    idempotencyKey,
    type,
    payload: { run },
  });
}

function createToolEventInput(input: Record<string, string | boolean>) {
  return toAppendInput({
    ...baseEnvelope,
    scopeType: "run",
    scopeId: "run_abc123",
    runId: "run_abc123",
    idempotencyKey: "tool:requested",
    type: "tool.call.requested",
    payload: {
      itemId: "itm_abc123",
      content: {
        toolCallId: "toolcall_abc123",
        toolName: "read_file",
        input,
      },
    },
  });
}

function toAppendInput(event: unknown) {
  const parsed = PlatformEventSchema.parse(event);
  const { eventId, sequence, cursor, createdAt, ...input } = parsed;
  void eventId;
  void sequence;
  void cursor;
  void createdAt;
  return input;
}

function createRow(params: readonly SqlValue[]): CanonicalEventRow {
  return {
    event_id: readStringParam(params[0], "event_id"),
    scope_type: readStringParam(params[1], "scope_type"),
    scope_id: readStringParam(params[2], "scope_id"),
    thread_id: readStringParam(params[3], "thread_id"),
    run_id: readNullableStringParam(params[4], "run_id"),
    workspace_id: readStringParam(params[5], "workspace_id"),
    artifact_id: readNullableStringParam(params[6], "artifact_id"),
    provider_id: readNullableStringParam(params[7], "provider_id"),
    sequence: readNumberParam(params[8], "sequence"),
    cursor: readStringParam(params[9], "cursor"),
    idempotency_key: readStringParam(params[10], "idempotency_key"),
    event_type: readStringParam(params[11], "event_type"),
    payload_json: JSON.parse(readStringParam(params[12], "payload_json")),
    schema_version: readNumberParam(params[13], "schema_version"),
    producer_kind: readStringParam(params[14], "producer_kind"),
    producer_id: readNullableStringParam(params[15], "producer_id"),
    created_at: readStringParam(params[16], "created_at"),
  };
}

function assertNoUniqueConflict(
  rows: readonly CanonicalEventRow[],
  row: CanonicalEventRow,
): void {
  if (rows.some((existing) => existing.event_id === row.event_id)) {
    throwUniqueViolation("canonical_events_event_id_unique");
  }
  if (rows.some((existing) => existing.cursor === row.cursor)) {
    throwUniqueViolation("canonical_events_cursor_unique");
  }
  if (
    rows.some(
      (existing) =>
        existing.scope_type === row.scope_type &&
        existing.scope_id === row.scope_id &&
        existing.idempotency_key === row.idempotency_key,
    )
  ) {
    throwUniqueViolation("canonical_events_scope_idempotency_idx");
  }
}

function throwUniqueViolation(constraint: string): never {
  throw { code: "23505", constraint };
}

function rowsResult<Row extends SqlRow>(rows: readonly SqlRow[]): SqlQueryResult<Row> {
  return { rows: rows as Row[], rowCount: rows.length };
}

function emptyResult<Row extends SqlRow>(): SqlQueryResult<Row> {
  return { rows: [], rowCount: 0 };
}

function scopeKey(params: readonly SqlValue[]): string {
  return `${readStringParam(params[0], "scope_type")}:${readStringParam(
    params[1],
    "scope_id",
  )}`;
}

function readStringParam(value: SqlValue | undefined, label: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Expected ${label} to be a string`);
}

function readNullableStringParam(
  value: SqlValue | undefined,
  label: string,
): string | null {
  if (value === null) {
    return null;
  }
  return readStringParam(value, label);
}

function readNumberParam(value: SqlValue | undefined, label: string): number {
  if (typeof value === "number") {
    return value;
  }
  throw new Error(`Expected ${label} to be a number`);
}

const baseEnvelope = {
  eventId: "evt_source01",
  threadId: "thr_abc123",
  workspaceId: "wrk_abc123",
  sequence: 1,
  cursor: "cursor_source01",
  createdAt: timestamp,
  producer: { kind: "runtime_kernel", id: "kernel" },
  schemaVersion: EVENT_SCHEMA_VERSION,
};

const run = {
  id: "run_abc123",
  threadId: "thr_abc123",
  userId: "usr_abc123",
  workspaceId: "wrk_abc123",
  status: "running",
  mode: "auto_edit",
  providerId: "openrouter",
  modelId: "z-ai/glm-4.5-air:free",
  workerId: "worker_abc123",
  permissionProfileId: "perm_abc123",
  startedAt: timestamp,
  completedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSequence: 1,
};
