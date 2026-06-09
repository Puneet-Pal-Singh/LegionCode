import {
  ApprovalOptionSchema,
  JsonRecordSchema,
  ProtocolErrorSchema,
  RunIdSchema,
  RunItemSchema,
  RunSchema,
  type ApprovalOption,
  type EventCursor,
  type EventId,
  type JsonRecord,
  type PlatformEvent,
  type ProtocolError,
  type Run,
  type RunId,
  type RunItem,
} from "@repo/platform-protocol";
import type { SqlClient, SqlRow } from "../sql.js";
import { projectRunEvents } from "./RunProjectionProjector.js";
import {
  RUN_PROJECTION_VERSION,
  RunProjectionError,
  parseApprovalProjection,
  parseToolCallProjection,
  type ApprovalProjection,
  type RebuildRunProjectionInput,
  type RunProjectionEventInput,
  type RunProjectionRepository,
  type RunProjectionSnapshot,
  type ToolCallProjection,
} from "./types.js";

interface RunProjectionRow extends SqlRow {
  run_id?: string;
  thread_id?: string;
  user_id?: string;
  workspace_id?: string;
  status?: string;
  mode?: string;
  provider_id?: string;
  model_id?: string;
  worker_id?: string;
  permission_profile_id?: string;
  started_at?: string | Date | null;
  completed_at?: string | Date | null;
  created_at?: string | Date;
  updated_at?: string | Date;
  last_event_sequence?: number | string;
  last_cursor?: string;
  projection_version?: number | string;
}

interface RunItemProjectionRow extends SqlRow {
  item_id?: string;
  run_id?: string;
  thread_id?: string;
  turn_id?: string;
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

interface ToolCallProjectionRow extends SqlRow {
  tool_call_id?: string;
  run_id?: string;
  thread_id?: string;
  item_id?: string;
  tool_name?: string;
  status?: string;
  input_json?: unknown;
  output_json?: unknown | null;
  output_text?: string;
  failure_json?: unknown | null;
  requested_at?: string | Date;
  started_at?: string | Date | null;
  completed_at?: string | Date | null;
  event_sequence?: number | string;
}

interface ApprovalProjectionRow extends SqlRow {
  approval_id?: string;
  run_id?: string;
  thread_id?: string;
  item_id?: string | null;
  status?: string;
  question?: string;
  options_json?: unknown;
  metadata_json?: unknown;
  decision?: string | null;
  decided_by?: string | null;
  reason?: string | null;
  requested_at?: string | Date;
  decided_at?: string | Date | null;
  event_sequence?: number | string;
}

interface ProjectionSource {
  eventId: EventId;
  cursor: EventCursor;
}

interface StoredRunProjection {
  run: Run;
  lastCursor: EventCursor;
}

export class PostgresRunProjectionRepository
  implements RunProjectionRepository
{
  constructor(private readonly client: SqlClient) {}

  async rebuildFromEvents(
    input: RebuildRunProjectionInput,
  ): Promise<RunProjectionSnapshot | null> {
    const runId = RunIdSchema.parse(input.runId);
    const snapshot = projectRunEvents(runId, input.events);
    if (snapshot === null) {
      return null;
    }
    const sources = buildProjectionSources(input.events);
    await this.client.transaction(async (tx) => {
      await upsertRunProjection(tx, snapshot);
      await replaceRunItems(tx, snapshot, sources.items);
      await replaceToolCalls(tx, snapshot, sources.toolCalls);
      await replaceApprovals(tx, snapshot, sources.approvals);
    });
    return snapshot;
  }

  async getRunProjection(
    runId: RunId,
  ): Promise<RunProjectionSnapshot | null> {
    const parsedRunId = RunIdSchema.parse(runId);
    const projection = await readRunProjection(this.client, parsedRunId);
    if (projection === null) {
      return null;
    }
    const items = await readRunItems(this.client, parsedRunId);
    const toolCalls = await readToolCalls(this.client, parsedRunId);
    const approvals = await readApprovals(this.client, parsedRunId);
    return {
      run: projection.run,
      items,
      toolCalls,
      approvals,
      lastCursor: projection.lastCursor,
      projectionVersion: RUN_PROJECTION_VERSION,
    };
  }
}

function buildProjectionSources(
  inputs: readonly RunProjectionEventInput[],
): {
  items: Map<string, ProjectionSource>;
  toolCalls: Map<string, ProjectionSource>;
  approvals: Map<string, ProjectionSource>;
} {
  const items = new Map<string, ProjectionSource>();
  const toolCalls = new Map<string, ProjectionSource>();
  const approvals = new Map<string, ProjectionSource>();
  for (const input of inputs) {
    updateProjectionSources(input, items, toolCalls, approvals);
  }
  return { items, toolCalls, approvals };
}

function updateProjectionSources(
  input: RunProjectionEventInput,
  items: Map<string, ProjectionSource>,
  toolCalls: Map<string, ProjectionSource>,
  approvals: Map<string, ProjectionSource>,
): void {
  const source = { eventId: input.event.eventId, cursor: input.event.cursor };
  if (isRunItemEvent(input.event)) {
    items.set(input.event.payload.item.id, source);
    return;
  }
  if (isAssistantTextEvent(input.event)) {
    items.set(input.event.payload.itemId, source);
    return;
  }
  if (isToolCallEvent(input.event)) {
    toolCalls.set(getToolCallId(input.event), source);
    return;
  }
  if (isApprovalEvent(input.event)) {
    approvals.set(input.event.payload.approvalId, source);
  }
}

function isRunItemEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `item.${string}` }> {
  return event.type.startsWith("item.");
}

function isAssistantTextEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `assistant.text.${string}` }> {
  return event.type.startsWith("assistant.text.");
}

function isToolCallEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `tool.call.${string}` }> {
  return event.type.startsWith("tool.call.");
}

function isApprovalEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `approval.${string}` }> {
  return event.type.startsWith("approval.");
}

function getToolCallId(
  event: Extract<PlatformEvent, { type: `tool.call.${string}` }>,
): string {
  return event.type === "tool.call.requested"
    ? event.payload.content.toolCallId
    : event.payload.toolCallId;
}

async function upsertRunProjection(
  client: SqlClient,
  snapshot: RunProjectionSnapshot,
): Promise<void> {
  await client.query(UPSERT_RUN_PROJECTION_SQL, [
    snapshot.run.id,
    snapshot.run.threadId,
    snapshot.run.userId,
    snapshot.run.workspaceId,
    snapshot.run.status,
    snapshot.run.mode,
    snapshot.run.providerId,
    snapshot.run.modelId,
    snapshot.run.workerId,
    snapshot.run.permissionProfileId,
    snapshot.run.startedAt,
    snapshot.run.completedAt,
    snapshot.run.createdAt,
    snapshot.run.updatedAt,
    snapshot.run.lastEventSequence,
    snapshot.lastCursor,
    snapshot.projectionVersion,
  ]);
}

async function replaceRunItems(
  client: SqlClient,
  snapshot: RunProjectionSnapshot,
  itemSources: Map<string, ProjectionSource>,
): Promise<void> {
  await client.query(DELETE_RUN_ITEMS_SQL, [snapshot.run.id]);
  for (const item of snapshot.items) {
    await insertRunItem(client, item, itemSources);
  }
}

async function insertRunItem(
  client: SqlClient,
  item: RunItem,
  itemSources: Map<string, ProjectionSource>,
): Promise<void> {
  const source = itemSources.get(item.id);
  if (!source) {
    throw new RunProjectionError(
      "missing_item_source",
      `Missing source event for projected run item: ${item.id}`,
    );
  }
  await client.query(INSERT_RUN_ITEM_SQL, [
    item.id,
    item.runId,
    item.threadId,
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
    RUN_PROJECTION_VERSION,
  ]);
}

async function replaceToolCalls(
  client: SqlClient,
  snapshot: RunProjectionSnapshot,
  toolCallSources: Map<string, ProjectionSource>,
): Promise<void> {
  await client.query(DELETE_TOOL_CALLS_SQL, [snapshot.run.id]);
  for (const toolCall of snapshot.toolCalls) {
    await insertToolCall(client, toolCall, toolCallSources);
  }
}

async function insertToolCall(
  client: SqlClient,
  toolCall: ToolCallProjection,
  toolCallSources: Map<string, ProjectionSource>,
): Promise<void> {
  const source = toolCallSources.get(toolCall.toolCallId);
  if (!source) {
    throw new RunProjectionError(
      "missing_tool_call_source",
      `Missing source event for projected tool call: ${toolCall.toolCallId}`,
    );
  }
  await client.query(INSERT_TOOL_CALL_SQL, [
    toolCall.toolCallId,
    toolCall.runId,
    toolCall.threadId,
    toolCall.itemId,
    toolCall.toolName,
    toolCall.status,
    JSON.stringify(toolCall.input),
    stringifyNullablePayload(toolCall.output),
    toolCall.outputText,
    stringifyNullablePayload(toolCall.failure),
    toolCall.requestedAt,
    toolCall.startedAt,
    toolCall.completedAt,
    toolCall.eventSequence,
    source.eventId,
    source.cursor,
    RUN_PROJECTION_VERSION,
  ]);
}

async function replaceApprovals(
  client: SqlClient,
  snapshot: RunProjectionSnapshot,
  approvalSources: Map<string, ProjectionSource>,
): Promise<void> {
  await client.query(DELETE_APPROVALS_SQL, [snapshot.run.id]);
  for (const approval of snapshot.approvals) {
    await insertApproval(client, approval, approvalSources);
  }
}

async function insertApproval(
  client: SqlClient,
  approval: ApprovalProjection,
  approvalSources: Map<string, ProjectionSource>,
): Promise<void> {
  const source = approvalSources.get(approval.approvalId);
  if (!source) {
    throw new RunProjectionError(
      "approval_not_requested",
      `Missing source event for projected approval: ${approval.approvalId}`,
    );
  }
  await client.query(INSERT_APPROVAL_SQL, [
    approval.approvalId,
    approval.runId,
    approval.threadId,
    approval.itemId,
    approval.status,
    approval.question,
    JSON.stringify(approval.options),
    JSON.stringify(approval.metadata),
    approval.decision,
    approval.decidedBy,
    approval.reason,
    approval.requestedAt,
    approval.decidedAt,
    approval.eventSequence,
    source.eventId,
    source.cursor,
    RUN_PROJECTION_VERSION,
  ]);
}

async function readRunProjection(
  client: SqlClient,
  runId: RunId,
): Promise<StoredRunProjection | null> {
  const result = await client.query<RunProjectionRow>(
    SELECT_RUN_PROJECTION_SQL,
    [runId],
  );
  const row = result.rows[0];
  return row ? mapRunProjectionRow(row) : null;
}

async function readRunItems(
  client: SqlClient,
  runId: RunId,
): Promise<RunItem[]> {
  const result = await client.query<RunItemProjectionRow>(
    SELECT_RUN_ITEMS_SQL,
    [runId],
  );
  return result.rows.map(mapRunItemProjectionRow);
}

async function readToolCalls(
  client: SqlClient,
  runId: RunId,
): Promise<ToolCallProjection[]> {
  const result = await client.query<ToolCallProjectionRow>(
    SELECT_TOOL_CALLS_SQL,
    [runId],
  );
  return result.rows.map(mapToolCallProjectionRow);
}

async function readApprovals(
  client: SqlClient,
  runId: RunId,
): Promise<ApprovalProjection[]> {
  const result = await client.query<ApprovalProjectionRow>(
    SELECT_APPROVALS_SQL,
    [runId],
  );
  return result.rows.map(mapApprovalProjectionRow);
}

function mapRunProjectionRow(row: RunProjectionRow): StoredRunProjection {
  return {
    run: RunSchema.parse({
      id: requireString(row.run_id, "run_id"),
      threadId: requireString(row.thread_id, "thread_id"),
      userId: requireString(row.user_id, "user_id"),
      workspaceId: requireString(row.workspace_id, "workspace_id"),
      status: requireString(row.status, "status"),
      mode: requireString(row.mode, "mode"),
      providerId: requireString(row.provider_id, "provider_id"),
      modelId: requireString(row.model_id, "model_id"),
      workerId: requireString(row.worker_id, "worker_id"),
      permissionProfileId: requireString(
        row.permission_profile_id,
        "permission_profile_id",
      ),
      startedAt: toNullableIsoString(row.started_at, "started_at"),
      completedAt: toNullableIsoString(row.completed_at, "completed_at"),
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

function mapRunItemProjectionRow(row: RunItemProjectionRow): RunItem {
  return RunItemSchema.parse({
    id: requireString(row.item_id, "item_id"),
    runId: requireString(row.run_id, "run_id"),
    threadId: requireString(row.thread_id, "thread_id"),
    turnId: requireString(row.turn_id, "turn_id"),
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

function mapToolCallProjectionRow(
  row: ToolCallProjectionRow,
): ToolCallProjection {
  return parseToolCallProjection({
    toolCallId: requireString(row.tool_call_id, "tool_call_id"),
    runId: requireString(row.run_id, "run_id"),
    threadId: requireString(row.thread_id, "thread_id"),
    itemId: requireString(row.item_id, "item_id"),
    toolName: requireString(row.tool_name, "tool_name"),
    status: requireString(row.status, "status"),
    input: parseJsonRecord(row.input_json, "input_json"),
    output: parseNullableJsonRecord(row.output_json, "output_json"),
    outputText: requireString(row.output_text, "output_text"),
    failure: parseNullableProtocolError(row.failure_json),
    requestedAt: toIsoString(row.requested_at, "requested_at"),
    startedAt: toNullableIsoString(row.started_at, "started_at"),
    completedAt: toNullableIsoString(row.completed_at, "completed_at"),
    eventSequence: toNumber(row.event_sequence, "event_sequence"),
  });
}

function mapApprovalProjectionRow(
  row: ApprovalProjectionRow,
): ApprovalProjection {
  return parseApprovalProjection({
    approvalId: requireString(row.approval_id, "approval_id"),
    runId: requireString(row.run_id, "run_id"),
    threadId: requireString(row.thread_id, "thread_id"),
    itemId: row.item_id ?? null,
    status: requireString(row.status, "status"),
    question: requireString(row.question, "question"),
    options: parseApprovalOptions(row.options_json),
    metadata: parseJsonRecord(row.metadata_json, "metadata_json"),
    decision: row.decision ?? null,
    decidedBy: row.decided_by ?? null,
    reason: row.reason ?? null,
    requestedAt: toIsoString(row.requested_at, "requested_at"),
    decidedAt: toNullableIsoString(row.decided_at, "decided_at"),
    eventSequence: toNumber(row.event_sequence, "event_sequence"),
  });
}

function stringifyNullablePayload(value: unknown | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return JSON.parse(value) as unknown;
}

function parseJsonRecord(value: unknown, columnName: string): JsonRecord {
  const payload = parsePayload(value);
  const result = JsonRecordSchema.safeParse(payload);
  if (result.success) {
    return result.data;
  }
  throw new Error(`Expected ${columnName} to be a JSON object`);
}

function parseNullableJsonRecord(
  value: unknown,
  columnName: string,
): JsonRecord | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseJsonRecord(value, columnName);
}

function parseApprovalOptions(value: unknown): ApprovalOption[] {
  return ApprovalOptionSchema.array().parse(parsePayload(value));
}

function parseNullableProtocolError(value: unknown): ProtocolError | null {
  if (value === null || value === undefined) {
    return null;
  }
  return ProtocolErrorSchema.parse(parsePayload(value));
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

const RUN_PROJECTION_COLUMNS = `
  run_id,
  thread_id,
  user_id,
  workspace_id,
  status,
  mode,
  provider_id,
  model_id,
  worker_id,
  permission_profile_id,
  started_at,
  completed_at,
  created_at,
  updated_at,
  last_event_sequence,
  last_cursor,
  projection_version
`;

const RUN_ITEM_PROJECTION_COLUMNS = `
  item_id,
  run_id,
  thread_id,
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

const TOOL_CALL_PROJECTION_COLUMNS = `
  tool_call_id,
  run_id,
  thread_id,
  item_id,
  tool_name,
  status,
  input_json,
  output_json,
  output_text,
  failure_json,
  requested_at,
  started_at,
  completed_at,
  event_sequence
`;

const APPROVAL_PROJECTION_COLUMNS = `
  approval_id,
  run_id,
  thread_id,
  item_id,
  status,
  question,
  options_json,
  metadata_json,
  decision,
  decided_by,
  reason,
  requested_at,
  decided_at,
  event_sequence
`;

const UPSERT_RUN_PROJECTION_SQL = `
  INSERT INTO canonical_run_projections (
    run_id,
    thread_id,
    user_id,
    workspace_id,
    status,
    mode,
    provider_id,
    model_id,
    worker_id,
    permission_profile_id,
    started_at,
    completed_at,
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
    $16,
    $17,
    now()
  )
  ON CONFLICT (run_id)
  DO UPDATE SET
    thread_id = EXCLUDED.thread_id,
    user_id = EXCLUDED.user_id,
    workspace_id = EXCLUDED.workspace_id,
    status = EXCLUDED.status,
    mode = EXCLUDED.mode,
    provider_id = EXCLUDED.provider_id,
    model_id = EXCLUDED.model_id,
    worker_id = EXCLUDED.worker_id,
    permission_profile_id = EXCLUDED.permission_profile_id,
    started_at = EXCLUDED.started_at,
    completed_at = EXCLUDED.completed_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    last_event_sequence = EXCLUDED.last_event_sequence,
    last_cursor = EXCLUDED.last_cursor,
    projection_version = EXCLUDED.projection_version,
    rebuilt_at = EXCLUDED.rebuilt_at
`;

const DELETE_RUN_ITEMS_SQL = `
  DELETE FROM canonical_run_item_projections
  WHERE run_id = $1
`;

const DELETE_TOOL_CALLS_SQL = `
  DELETE FROM canonical_tool_call_projections
  WHERE run_id = $1
`;

const DELETE_APPROVALS_SQL = `
  DELETE FROM canonical_approval_projections
  WHERE run_id = $1
`;

const INSERT_RUN_ITEM_SQL = `
  INSERT INTO canonical_run_item_projections (
    item_id,
    run_id,
    thread_id,
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

const INSERT_TOOL_CALL_SQL = `
  INSERT INTO canonical_tool_call_projections (
    tool_call_id,
    run_id,
    thread_id,
    item_id,
    tool_name,
    status,
    input_json,
    output_json,
    output_text,
    failure_json,
    requested_at,
    started_at,
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
    $7::jsonb,
    $8::jsonb,
    $9,
    $10::jsonb,
    $11,
    $12,
    $13,
    $14,
    $15,
    $16,
    $17,
    now()
  )
`;

const INSERT_APPROVAL_SQL = `
  INSERT INTO canonical_approval_projections (
    approval_id,
    run_id,
    thread_id,
    item_id,
    status,
    question,
    options_json,
    metadata_json,
    decision,
    decided_by,
    reason,
    requested_at,
    decided_at,
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
    $7::jsonb,
    $8::jsonb,
    $9,
    $10,
    $11,
    $12,
    $13,
    $14,
    $15,
    $16,
    $17,
    now()
  )
`;

const SELECT_RUN_PROJECTION_SQL = `
  SELECT ${RUN_PROJECTION_COLUMNS}
  FROM canonical_run_projections
  WHERE run_id = $1
`;

const SELECT_RUN_ITEMS_SQL = `
  SELECT ${RUN_ITEM_PROJECTION_COLUMNS}
  FROM canonical_run_item_projections
  WHERE run_id = $1
  ORDER BY event_sequence ASC
`;

const SELECT_TOOL_CALLS_SQL = `
  SELECT ${TOOL_CALL_PROJECTION_COLUMNS}
  FROM canonical_tool_call_projections
  WHERE run_id = $1
  ORDER BY event_sequence ASC
`;

const SELECT_APPROVALS_SQL = `
  SELECT ${APPROVAL_PROJECTION_COLUMNS}
  FROM canonical_approval_projections
  WHERE run_id = $1
  ORDER BY event_sequence ASC
`;
