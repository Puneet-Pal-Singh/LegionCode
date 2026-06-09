import {
  EVENT_SCHEMA_VERSION,
  PlatformEventSchema,
  type EventCursor,
  type EventId,
  type PlatformEvent,
  type ThreadId,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresThreadProjectionRepository } from "./PostgresThreadProjectionRepository.js";
import type { ThreadProjectionEventInput } from "./types.js";

const timestamp = "2026-06-09T12:00:00.000Z";
const threadId = "thr_abc123" as ThreadId;

interface ThreadProjectionRow extends SqlRow {
  thread_id: string;
  user_id: string;
  workspace_id: string;
  title: string;
  title_source: string;
  status: string;
  pinned_at: string | null;
  archived_at: string | null;
  active_run_id: string | null;
  active_leaf_item_id: string | null;
  created_at: string;
  updated_at: string;
  last_event_sequence: number;
  last_cursor: string;
  projection_version: number;
}

interface ThreadItemProjectionRow extends SqlRow {
  item_id: string;
  thread_id: string;
  run_id: string | null;
  turn_id: string | null;
  parent_item_id: string | null;
  branch_id: string | null;
  role: string;
  item_type: string;
  status: string;
  content_json: unknown;
  created_at: string;
  completed_at: string | null;
  event_sequence: number;
  source_event_id: string;
  source_cursor: string;
  projection_version: number;
}

class ThreadProjectionSqlClient implements SqlClient {
  readonly queries: Array<{ statement: string; params: readonly SqlValue[] }> =
    [];
  private threads = new Map<string, ThreadProjectionRow>();
  private items = new Map<string, ThreadItemProjectionRow>();

  constructor(private readonly options: { failOnItemId?: string } = {}) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.queries.push({ statement, params });
    if (statement.includes("INSERT INTO canonical_thread_projections")) {
      this.upsertThread(params);
      return emptyResult();
    }
    if (statement.includes("DELETE FROM canonical_thread_item_projections")) {
      this.deleteThreadItems(params);
      return emptyResult();
    }
    if (statement.includes("INSERT INTO canonical_thread_item_projections")) {
      this.insertThreadItem(params);
      return emptyResult();
    }
    if (statement.includes("FROM canonical_thread_projections")) {
      return rowsResult<Row>(this.selectThread(params));
    }
    if (statement.includes("FROM canonical_thread_item_projections")) {
      return rowsResult<Row>(this.selectItems(params));
    }
    throw new Error(`Unhandled SQL: ${statement}`);
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    const threads = new Map(this.threads);
    const items = new Map(this.items);
    try {
      return await callback(this);
    } catch (error) {
      this.threads = threads;
      this.items = items;
      throw error;
    }
  }

  countItems(): number {
    return this.items.size;
  }

  private upsertThread(params: readonly SqlValue[]): void {
    const row = createThreadRow(params);
    this.threads.set(row.thread_id, row);
  }

  private deleteThreadItems(params: readonly SqlValue[]): void {
    const threadIdParam = readStringParam(params[0], "thread_id");
    for (const [itemId, item] of this.items) {
      if (item.thread_id === threadIdParam) {
        this.items.delete(itemId);
      }
    }
  }

  private insertThreadItem(params: readonly SqlValue[]): void {
    const row = createThreadItemRow(params);
    if (row.item_id === this.options.failOnItemId) {
      throw new Error(`Simulated item insert failure: ${row.item_id}`);
    }
    if (!this.threads.has(row.thread_id)) {
      throw new Error(`Thread projection not found: ${row.thread_id}`);
    }
    this.items.set(row.item_id, row);
  }

  private selectThread(params: readonly SqlValue[]): ThreadProjectionRow[] {
    const row = this.threads.get(readStringParam(params[0], "thread_id"));
    return row ? [row] : [];
  }

  private selectItems(params: readonly SqlValue[]): ThreadItemProjectionRow[] {
    const threadIdParam = readStringParam(params[0], "thread_id");
    return [...this.items.values()]
      .filter((item) => item.thread_id === threadIdParam)
      .sort((left, right) => left.event_sequence - right.event_sequence);
  }
}

describe("PostgresThreadProjectionRepository", () => {
  it("persists and reads rebuilt thread projections", async () => {
    const client = new ThreadProjectionSqlClient();
    const repository = new PostgresThreadProjectionRepository(client);

    const snapshot = await repository.rebuildFromEvents({
      threadId,
      events: [
        projectionInput(createThreadEvent("thread.created", thread, 1), 1),
        projectionInput(createItemEvent("item.completed", userItem, 2), 2),
        projectionInput(createItemEvent("item.completed", assistantItem, 3), 3),
      ],
    });
    const persisted = await repository.getThreadProjection(threadId);

    expect(snapshot?.items).toHaveLength(2);
    expect(persisted?.thread.activeLeafItemId).toBe("itm_asst001");
    expect(persisted?.items.map((item) => item.id)).toEqual([
      "itm_user001",
      "itm_asst001",
    ]);
    expect(persisted?.lastCursor).toBe("cursor_000003");
  });

  it("replaces stale item projection rows on rebuild", async () => {
    const client = new ThreadProjectionSqlClient();
    const repository = new PostgresThreadProjectionRepository(client);

    await repository.rebuildFromEvents({
      threadId,
      events: [
        projectionInput(createThreadEvent("thread.created", thread, 1), 1),
        projectionInput(createItemEvent("item.completed", userItem, 2), 2),
      ],
    });
    await repository.rebuildFromEvents({
      threadId,
      events: [
        projectionInput(createThreadEvent("thread.created", thread, 1), 1),
        projectionInput(createItemEvent("item.completed", assistantItem, 3), 3),
      ],
    });

    const persisted = await repository.getThreadProjection(threadId);
    expect(client.countItems()).toBe(1);
    expect(persisted?.items.map((item) => item.id)).toEqual(["itm_asst001"]);
  });

  it("rolls back when item materialization fails", async () => {
    const client = new ThreadProjectionSqlClient({
      failOnItemId: "itm_user001",
    });
    const repository = new PostgresThreadProjectionRepository(client);

    await expect(
      repository.rebuildFromEvents({
        threadId,
        events: [
          projectionInput(createThreadEvent("thread.created", thread, 1), 1),
          projectionInput(createItemEvent("item.completed", userItem, 2), 2),
        ],
      }),
    ).rejects.toThrow("Simulated item insert failure");

    await expect(repository.getThreadProjection(threadId)).resolves.toBeNull();
  });
});

function projectionInput(
  event: PlatformEvent,
  projectionSequence: number,
): ThreadProjectionEventInput {
  return { event, projectionSequence };
}

function createThreadEvent(
  type: "thread.created",
  threadPayload: typeof thread,
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope(type, threadPayload.id, sequence),
    runId: null,
    scopeType: "thread",
    scopeId: threadPayload.id,
    type,
    payload: { thread: threadPayload },
  });
}

function createItemEvent(
  type: "item.completed",
  item: typeof userItem,
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope(type, item.threadId, sequence),
    runId: item.runId,
    scopeType: "run",
    scopeId: item.runId,
    type,
    payload: { item },
  });
}

function baseEnvelope(type: string, eventThreadId: string, sequence: number) {
  return {
    eventId: `evt_${sequence.toString().padStart(6, "0")}` as EventId,
    threadId: eventThreadId,
    workspaceId: "wrk_abc123",
    sequence,
    cursor: `cursor_${sequence.toString().padStart(6, "0")}` as EventCursor,
    idempotencyKey: `${eventThreadId}:${type}:${sequence}`,
    createdAt: timestamp,
    producer: { kind: "runtime_kernel", id: "kernel" },
    schemaVersion: EVENT_SCHEMA_VERSION,
  };
}

function createThreadRow(params: readonly SqlValue[]): ThreadProjectionRow {
  return {
    thread_id: readStringParam(params[0], "thread_id"),
    user_id: readStringParam(params[1], "user_id"),
    workspace_id: readStringParam(params[2], "workspace_id"),
    title: readStringParam(params[3], "title"),
    title_source: readStringParam(params[4], "title_source"),
    status: readStringParam(params[5], "status"),
    pinned_at: readNullableStringParam(params[6], "pinned_at"),
    archived_at: readNullableStringParam(params[7], "archived_at"),
    active_run_id: readNullableStringParam(params[8], "active_run_id"),
    active_leaf_item_id: readNullableStringParam(
      params[9],
      "active_leaf_item_id",
    ),
    created_at: readStringParam(params[10], "created_at"),
    updated_at: readStringParam(params[11], "updated_at"),
    last_event_sequence: readNumberParam(params[12], "last_event_sequence"),
    last_cursor: readStringParam(params[13], "last_cursor"),
    projection_version: readNumberParam(params[14], "projection_version"),
  };
}

function createThreadItemRow(
  params: readonly SqlValue[],
): ThreadItemProjectionRow {
  return {
    item_id: readStringParam(params[0], "item_id"),
    thread_id: readStringParam(params[1], "thread_id"),
    run_id: readNullableStringParam(params[2], "run_id"),
    turn_id: readNullableStringParam(params[3], "turn_id"),
    parent_item_id: readNullableStringParam(params[4], "parent_item_id"),
    branch_id: readNullableStringParam(params[5], "branch_id"),
    role: readStringParam(params[6], "role"),
    item_type: readStringParam(params[7], "item_type"),
    status: readStringParam(params[8], "status"),
    content_json: JSON.parse(readStringParam(params[9], "content_json")),
    created_at: readStringParam(params[10], "created_at"),
    completed_at: readNullableStringParam(params[11], "completed_at"),
    event_sequence: readNumberParam(params[12], "event_sequence"),
    source_event_id: readStringParam(params[13], "source_event_id"),
    source_cursor: readStringParam(params[14], "source_cursor"),
    projection_version: readNumberParam(params[15], "projection_version"),
  };
}

function rowsResult<Row extends SqlRow>(
  rows: readonly SqlRow[],
): SqlQueryResult<Row> {
  return { rows: rows as Row[], rowCount: rows.length };
}

function emptyResult<Row extends SqlRow>(): SqlQueryResult<Row> {
  return { rows: [], rowCount: 0 };
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

const thread = {
  id: "thr_abc123",
  userId: "usr_abc123",
  workspaceId: "wrk_abc123",
  title: "Rebuild thread",
  titleSource: "generated",
  status: "active",
  pinnedAt: null,
  archivedAt: null,
  activeRunId: null,
  activeLeafItemId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSequence: 1,
};

const userItem = {
  id: "itm_user001",
  threadId: "thr_abc123",
  runId: "run_abc123",
  turnId: "trn_abc123",
  parentItemId: null,
  branchId: null,
  role: "user",
  status: "completed",
  createdAt: timestamp,
  completedAt: timestamp,
  eventSequence: 1,
  type: "user_message",
  content: { text: "Old prompt" },
};

const assistantItem = {
  ...userItem,
  id: "itm_asst001",
  role: "assistant",
  type: "assistant_message",
  content: { text: "Old answer" },
};
