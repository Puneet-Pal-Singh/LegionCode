import {
  ThreadIdSchema,
  ThreadItemSchema,
  ThreadSchema,
  type EventCursor,
  type EventId,
  type PlatformEvent,
  type Thread,
  type ThreadId,
  type ThreadItem,
} from "@repo/platform-protocol";
import type { SqlClient, SqlRow } from "../sql.js";
import { projectThreadEvents } from "./ThreadProjectionProjector.js";
import {
  THREAD_PROJECTION_VERSION,
  ThreadProjectionError,
  type RebuildThreadProjectionInput,
  type ThreadProjectionEventInput,
  type ThreadProjectionRepository,
  type ThreadProjectionSnapshot,
} from "./types.js";

interface ThreadProjectionRow extends SqlRow {
  thread_id?: string;
  user_id?: string;
  workspace_id?: string;
  title?: string;
  title_source?: string;
  status?: string;
  pinned_at?: string | Date | null;
  archived_at?: string | Date | null;
  active_run_id?: string | null;
  active_leaf_item_id?: string | null;
  created_at?: string | Date;
  updated_at?: string | Date;
  last_event_sequence?: number | string;
  last_cursor?: string;
  projection_version?: number | string;
}

interface ThreadItemProjectionRow extends SqlRow {
  item_id?: string;
  thread_id?: string;
  run_id?: string | null;
  turn_id?: string | null;
  parent_item_id?: string | null;
  branch_id?: string | null;
  role?: string;
  item_type?: string;
  status?: string;
  content_json?: unknown;
  created_at?: string | Date;
  completed_at?: string | Date | null;
  event_sequence?: number | string;
}

interface ItemSource {
  eventId: EventId;
  cursor: EventCursor;
}

interface StoredThreadProjection {
  thread: Thread;
  lastCursor: EventCursor;
}

export class PostgresThreadProjectionRepository
  implements ThreadProjectionRepository
{
  constructor(private readonly client: SqlClient) {}

  async rebuildFromEvents(
    input: RebuildThreadProjectionInput,
  ): Promise<ThreadProjectionSnapshot | null> {
    const threadId = ThreadIdSchema.parse(input.threadId);
    const snapshot = projectThreadEvents(threadId, input.events);
    if (snapshot === null) {
      return null;
    }
    const itemSources = buildItemSources(input.events);
    await this.client.transaction(async (tx) => {
      await upsertThreadProjection(tx, snapshot);
      await replaceThreadItems(tx, snapshot, itemSources);
    });
    return snapshot;
  }

  async getThreadProjection(
    threadId: ThreadId,
  ): Promise<ThreadProjectionSnapshot | null> {
    const parsedThreadId = ThreadIdSchema.parse(threadId);
    const projection = await readThreadProjection(this.client, parsedThreadId);
    if (projection === null) {
      return null;
    }
    const items = await readThreadItems(this.client, parsedThreadId);
    return {
      thread: projection.thread,
      items,
      lastCursor: projection.lastCursor,
      projectionVersion: THREAD_PROJECTION_VERSION,
    };
  }
}

function buildItemSources(
  inputs: readonly ThreadProjectionEventInput[],
): Map<string, ItemSource> {
  const sources = new Map<string, ItemSource>();
  for (const input of inputs) {
    if (isThreadItemEvent(input.event)) {
      sources.set(input.event.payload.item.id, {
        eventId: input.event.eventId,
        cursor: input.event.cursor,
      });
    }
  }
  return sources;
}

function isThreadItemEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `item.${string}` }> {
  return event.type.startsWith("item.");
}

async function upsertThreadProjection(
  client: SqlClient,
  snapshot: ThreadProjectionSnapshot,
): Promise<void> {
  await client.query(UPSERT_THREAD_PROJECTION_SQL, [
    snapshot.thread.id,
    snapshot.thread.userId,
    snapshot.thread.workspaceId,
    snapshot.thread.title,
    snapshot.thread.titleSource,
    snapshot.thread.status,
    snapshot.thread.pinnedAt,
    snapshot.thread.archivedAt,
    snapshot.thread.activeRunId,
    snapshot.thread.activeLeafItemId,
    snapshot.thread.createdAt,
    snapshot.thread.updatedAt,
    snapshot.thread.lastEventSequence,
    snapshot.lastCursor,
    snapshot.projectionVersion,
  ]);
}

async function replaceThreadItems(
  client: SqlClient,
  snapshot: ThreadProjectionSnapshot,
  itemSources: Map<string, ItemSource>,
): Promise<void> {
  await client.query(DELETE_THREAD_ITEMS_SQL, [snapshot.thread.id]);
  for (const item of snapshot.items) {
    await insertThreadItem(client, item, itemSources);
  }
}

async function insertThreadItem(
  client: SqlClient,
  item: ThreadItem,
  itemSources: Map<string, ItemSource>,
): Promise<void> {
  const source = itemSources.get(item.id);
  if (!source) {
    throw new ThreadProjectionError(
      "missing_item_source",
      `Missing source event for projected item: ${item.id}`,
    );
  }
  await client.query(INSERT_THREAD_ITEM_SQL, [
    item.id,
    item.threadId,
    item.runId,
    item.turnId,
    item.parentItemId,
    item.branchId,
    item.role,
    item.type,
    item.status,
    JSON.stringify(item.content),
    item.createdAt,
    item.completedAt,
    item.eventSequence,
    source.eventId,
    source.cursor,
    THREAD_PROJECTION_VERSION,
  ]);
}

async function readThreadProjection(
  client: SqlClient,
  threadId: ThreadId,
): Promise<StoredThreadProjection | null> {
  const result = await client.query<ThreadProjectionRow>(
    SELECT_THREAD_PROJECTION_SQL,
    [threadId],
  );
  const row = result.rows[0];
  return row ? mapThreadProjectionRow(row) : null;
}

async function readThreadItems(
  client: SqlClient,
  threadId: ThreadId,
): Promise<ThreadItem[]> {
  const result = await client.query<ThreadItemProjectionRow>(
    SELECT_THREAD_ITEMS_SQL,
    [threadId],
  );
  return result.rows.map(mapThreadItemProjectionRow);
}

function mapThreadProjectionRow(
  row: ThreadProjectionRow,
): StoredThreadProjection {
  return {
    thread: ThreadSchema.parse({
      id: requireString(row.thread_id, "thread_id"),
      userId: requireString(row.user_id, "user_id"),
      workspaceId: requireString(row.workspace_id, "workspace_id"),
      title: requireString(row.title, "title"),
      titleSource: requireString(row.title_source, "title_source"),
      status: requireString(row.status, "status"),
      pinnedAt: toNullableIsoString(row.pinned_at, "pinned_at"),
      archivedAt: toNullableIsoString(row.archived_at, "archived_at"),
      activeRunId: row.active_run_id ?? null,
      activeLeafItemId: row.active_leaf_item_id ?? null,
      createdAt: toIsoString(row.created_at, "created_at"),
      updatedAt: toIsoString(row.updated_at, "updated_at"),
      lastEventSequence: toNumber(
        row.last_event_sequence,
        "last_event_sequence",
      ),
    }),
    lastCursor: requireString(row.last_cursor, "last_cursor") as EventCursor,
  };
}

function mapThreadItemProjectionRow(row: ThreadItemProjectionRow): ThreadItem {
  return ThreadItemSchema.parse({
    id: requireString(row.item_id, "item_id"),
    threadId: requireString(row.thread_id, "thread_id"),
    runId: row.run_id ?? null,
    turnId: row.turn_id ?? null,
    parentItemId: row.parent_item_id ?? null,
    branchId: row.branch_id ?? null,
    role: requireString(row.role, "role"),
    type: requireString(row.item_type, "item_type"),
    status: requireString(row.status, "status"),
    content: parsePayload(row.content_json),
    createdAt: toIsoString(row.created_at, "created_at"),
    completedAt: toNullableIsoString(row.completed_at, "completed_at"),
    eventSequence: toNumber(row.event_sequence, "event_sequence"),
  });
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return JSON.parse(value) as unknown;
}

function requireString(value: unknown, columnName: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Expected ${columnName} to be a string`);
}

function toIsoString(value: unknown, columnName: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Expected ${columnName} to be a timestamp`);
}

function toNullableIsoString(
  value: unknown,
  columnName: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toIsoString(value, columnName);
}

function toNumber(value: unknown, columnName: string): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  throw new Error(`Expected ${columnName} to be numeric`);
}

const THREAD_PROJECTION_COLUMNS = `
  thread_id,
  user_id,
  workspace_id,
  title,
  title_source,
  status,
  pinned_at,
  archived_at,
  active_run_id,
  active_leaf_item_id,
  created_at,
  updated_at,
  last_event_sequence,
  last_cursor,
  projection_version
`;

const THREAD_ITEM_PROJECTION_COLUMNS = `
  item_id,
  thread_id,
  run_id,
  turn_id,
  parent_item_id,
  branch_id,
  role,
  item_type,
  status,
  content_json,
  created_at,
  completed_at,
  event_sequence
`;

const UPSERT_THREAD_PROJECTION_SQL = `
  INSERT INTO canonical_thread_projections (
    thread_id,
    user_id,
    workspace_id,
    title,
    title_source,
    status,
    pinned_at,
    archived_at,
    active_run_id,
    active_leaf_item_id,
    created_at,
    updated_at,
    last_event_sequence,
    last_cursor,
    projection_version,
    rebuilt_at
  )
  VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11,
    $12,
    $13,
    $14,
    $15,
    now()
  )
  ON CONFLICT (thread_id)
  DO UPDATE SET
    user_id = EXCLUDED.user_id,
    workspace_id = EXCLUDED.workspace_id,
    title = EXCLUDED.title,
    title_source = EXCLUDED.title_source,
    status = EXCLUDED.status,
    pinned_at = EXCLUDED.pinned_at,
    archived_at = EXCLUDED.archived_at,
    active_run_id = EXCLUDED.active_run_id,
    active_leaf_item_id = EXCLUDED.active_leaf_item_id,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    last_event_sequence = EXCLUDED.last_event_sequence,
    last_cursor = EXCLUDED.last_cursor,
    projection_version = EXCLUDED.projection_version,
    rebuilt_at = EXCLUDED.rebuilt_at
`;

const DELETE_THREAD_ITEMS_SQL = `
  DELETE FROM canonical_thread_item_projections
  WHERE thread_id = $1
`;

const INSERT_THREAD_ITEM_SQL = `
  INSERT INTO canonical_thread_item_projections (
    item_id,
    thread_id,
    run_id,
    turn_id,
    parent_item_id,
    branch_id,
    role,
    item_type,
    status,
    content_json,
    created_at,
    completed_at,
    event_sequence,
    source_event_id,
    source_cursor,
    projection_version,
    projected_at
  )
  VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10::jsonb,
    $11,
    $12,
    $13,
    $14,
    $15,
    $16,
    now()
  )
`;

const SELECT_THREAD_PROJECTION_SQL = `
  SELECT ${THREAD_PROJECTION_COLUMNS}
  FROM canonical_thread_projections
  WHERE thread_id = $1
`;

const SELECT_THREAD_ITEMS_SQL = `
  SELECT ${THREAD_ITEM_PROJECTION_COLUMNS}
  FROM canonical_thread_item_projections
  WHERE thread_id = $1
  ORDER BY event_sequence ASC
`;
