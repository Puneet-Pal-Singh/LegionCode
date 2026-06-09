import {
  EVENT_SCHEMA_VERSION,
  PlatformEventSchema,
  type EventCursor,
  type EventId,
  type PlatformEvent,
  type RunId,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresRunProjectionRepository } from "./PostgresRunProjectionRepository.js";
import type { RunProjectionEventInput } from "./types.js";

const timestamp = "2026-06-09T12:00:00.000Z";
const runId = "run_abc123" as RunId;

interface RunProjectionRow extends SqlRow {
  run_id: string;
  thread_id: string;
  user_id: string;
  workspace_id: string;
  status: string;
  mode: string;
  provider_id: string;
  model_id: string;
  worker_id: string;
  permission_profile_id: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  last_event_sequence: number;
  last_cursor: string;
  projection_version: number;
}

interface RunItemProjectionRow extends SqlRow {
  item_id: string;
  run_id: string;
  thread_id: string;
  turn_id: string;
  parent_item_id: string | null;
  branch_id: string | null;
  role: string;
  item_type: string;
  status: string;
  content_json: unknown;
  created_at: string;
  completed_at: string | null;
  event_sequence: number;
}

interface ToolCallProjectionRow extends SqlRow {
  tool_call_id: string;
  run_id: string;
  thread_id: string;
  item_id: string;
  tool_name: string;
  status: string;
  input_json: unknown;
  output_json: unknown | null;
  output_text: string;
  failure_json: unknown | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  event_sequence: number;
}

interface ApprovalProjectionRow extends SqlRow {
  approval_id: string;
  run_id: string;
  thread_id: string;
  item_id: string | null;
  status: string;
  question: string;
  options_json: unknown;
  metadata_json: unknown;
  decision: string | null;
  decided_by: string | null;
  reason: string | null;
  requested_at: string;
  decided_at: string | null;
  event_sequence: number;
}

class RunProjectionSqlClient implements SqlClient {
  private runs = new Map<string, RunProjectionRow>();
  private items = new Map<string, RunItemProjectionRow>();
  private toolCalls = new Map<string, ToolCallProjectionRow>();
  private approvals = new Map<string, ApprovalProjectionRow>();

  constructor(private readonly options: { failOnItemId?: string } = {}) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    if (statement.includes("INSERT INTO canonical_run_projections")) {
      this.upsertRun(params);
      return emptyResult();
    }
    if (statement.includes("DELETE FROM canonical_run_item_projections")) {
      this.deleteByRunId(this.items, params);
      return emptyResult();
    }
    if (statement.includes("DELETE FROM canonical_tool_call_projections")) {
      this.deleteByRunId(this.toolCalls, params);
      return emptyResult();
    }
    if (statement.includes("DELETE FROM canonical_approval_projections")) {
      this.deleteByRunId(this.approvals, params);
      return emptyResult();
    }
    if (statement.includes("INSERT INTO canonical_run_item_projections")) {
      this.insertRunItem(params);
      return emptyResult();
    }
    if (statement.includes("INSERT INTO canonical_tool_call_projections")) {
      this.insertToolCall(params);
      return emptyResult();
    }
    if (statement.includes("INSERT INTO canonical_approval_projections")) {
      this.insertApproval(params);
      return emptyResult();
    }
    if (statement.includes("FROM canonical_run_projections")) {
      return rowsResult<Row>(this.selectRun(params));
    }
    if (statement.includes("FROM canonical_run_item_projections")) {
      return rowsResult<Row>(this.selectByRunId(this.items, params));
    }
    if (statement.includes("FROM canonical_tool_call_projections")) {
      return rowsResult<Row>(this.selectByRunId(this.toolCalls, params));
    }
    if (statement.includes("FROM canonical_approval_projections")) {
      return rowsResult<Row>(this.selectByRunId(this.approvals, params));
    }
    throw new Error(`Unhandled SQL: ${statement}`);
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    const runs = new Map(this.runs);
    const items = new Map(this.items);
    const toolCalls = new Map(this.toolCalls);
    const approvals = new Map(this.approvals);
    try {
      return await callback(this);
    } catch (error) {
      this.runs = runs;
      this.items = items;
      this.toolCalls = toolCalls;
      this.approvals = approvals;
      throw error;
    }
  }

  countItems(): number {
    return this.items.size;
  }

  private upsertRun(params: readonly SqlValue[]): void {
    const row = createRunRow(params);
    this.runs.set(row.run_id, row);
  }

  private deleteByRunId<Row extends { run_id: string }>(
    rows: Map<string, Row>,
    params: readonly SqlValue[],
  ): void {
    const runIdParam = readStringParam(params[0], "run_id");
    for (const [id, row] of rows) {
      if (row.run_id === runIdParam) {
        rows.delete(id);
      }
    }
  }

  private insertRunItem(params: readonly SqlValue[]): void {
    const row = createRunItemRow(params);
    if (row.item_id === this.options.failOnItemId) {
      throw new Error(`Simulated item insert failure: ${row.item_id}`);
    }
    this.items.set(row.item_id, row);
  }

  private insertToolCall(params: readonly SqlValue[]): void {
    const row = createToolCallRow(params);
    this.toolCalls.set(row.tool_call_id, row);
  }

  private insertApproval(params: readonly SqlValue[]): void {
    const row = createApprovalRow(params);
    this.approvals.set(row.approval_id, row);
  }

  private selectRun(params: readonly SqlValue[]): RunProjectionRow[] {
    const row = this.runs.get(readStringParam(params[0], "run_id"));
    return row ? [row] : [];
  }

  private selectByRunId<Row extends { run_id: string; event_sequence: number }>(
    rows: Map<string, Row>,
    params: readonly SqlValue[],
  ): Row[] {
    const runIdParam = readStringParam(params[0], "run_id");
    return [...rows.values()]
      .filter((row) => row.run_id === runIdParam)
      .sort((left, right) => left.event_sequence - right.event_sequence);
  }
}

describe("PostgresRunProjectionRepository", () => {
  it("persists and reads rebuilt run projections", async () => {
    const client = new RunProjectionSqlClient();
    const repository = new PostgresRunProjectionRepository(client);

    const snapshot = await repository.rebuildFromEvents({
      runId,
      events: [
        projectionInput(createRunEvent("run.created", queuedRun, 1), 1),
        projectionInput(createItemEvent("item.started", assistantItem, 2), 2),
        projectionInput(createAssistantTextCompletedEvent("Done", 3), 3),
        projectionInput(createToolRequestedEvent(4), 4),
        projectionInput(createToolCompletedEvent(5), 5),
        projectionInput(createApprovalRequestedEvent(6), 6),
        projectionInput(createApprovalDecidedEvent(7), 7),
      ],
    });
    const persisted = await repository.getRunProjection(runId);

    expect(snapshot?.items).toHaveLength(1);
    expect(persisted?.run.lastEventSequence).toBe(1);
    expect(persisted?.items[0]?.content).toEqual({ text: "Done" });
    expect(persisted?.toolCalls[0]).toMatchObject({
      toolCallId: "toolcall_read01",
      status: "completed",
      output: { text: "done" },
    });
    expect(persisted?.approvals[0]).toMatchObject({
      approvalId: "appr_allow1",
      status: "decided",
      decision: "approved",
    });
    expect(persisted?.lastCursor).toBe("cursor_000007");
  });

  it("replaces stale derived rows on rebuild", async () => {
    const client = new RunProjectionSqlClient();
    const repository = new PostgresRunProjectionRepository(client);

    await repository.rebuildFromEvents({
      runId,
      events: [
        projectionInput(createRunEvent("run.created", queuedRun, 1), 1),
        projectionInput(createItemEvent("item.started", assistantItem, 2), 2),
      ],
    });
    await repository.rebuildFromEvents({
      runId,
      events: [
        projectionInput(createRunEvent("run.created", queuedRun, 1), 1),
      ],
    });

    const persisted = await repository.getRunProjection(runId);
    expect(client.countItems()).toBe(0);
    expect(persisted?.items).toHaveLength(0);
  });

  it("rolls back when run item materialization fails", async () => {
    const client = new RunProjectionSqlClient({ failOnItemId: "itm_asst001" });
    const repository = new PostgresRunProjectionRepository(client);

    await expect(
      repository.rebuildFromEvents({
        runId,
        events: [
          projectionInput(createRunEvent("run.created", queuedRun, 1), 1),
          projectionInput(createItemEvent("item.started", assistantItem, 2), 2),
        ],
      }),
    ).rejects.toThrow("Simulated item insert failure");

    await expect(repository.getRunProjection(runId)).resolves.toBeNull();
  });
});

function projectionInput(
  event: PlatformEvent,
  projectionSequence: number,
): RunProjectionEventInput {
  return { event, projectionSequence };
}

function createRunEvent(
  type: "run.created",
  runPayload: typeof queuedRun,
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope(type, sequence),
    type,
    payload: { run: runPayload },
  });
}

function createItemEvent(
  type: "item.started",
  item: typeof assistantItem,
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope(type, sequence),
    type,
    payload: { item },
  });
}

function createAssistantTextCompletedEvent(
  text: string,
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("assistant.text.completed", sequence),
    type: "assistant.text.completed",
    payload: { itemId: "itm_asst001", text },
  });
}

function createToolRequestedEvent(sequence: number): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("tool.call.requested", sequence),
    type: "tool.call.requested",
    payload: {
      itemId: "itm_tool001",
      content: {
        toolCallId: "toolcall_read01",
        toolName: "read_file",
        input: { path: "packages/persistence/src/index.ts" },
      },
    },
  });
}

function createToolCompletedEvent(sequence: number): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("tool.call.completed", sequence),
    type: "tool.call.completed",
    payload: {
      itemId: "itm_tool001",
      toolCallId: "toolcall_read01",
      output: { text: "done" },
    },
  });
}

function createApprovalRequestedEvent(sequence: number): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("approval.requested", sequence),
    type: "approval.requested",
    payload: {
      approvalId: "appr_allow1",
      itemId: "itm_tool001",
      question: "Allow file read?",
      options: [{ id: "approve", label: "Approve", description: null }],
      metadata: { toolName: "read_file" },
    },
  });
}

function createApprovalDecidedEvent(sequence: number): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("approval.decided", sequence),
    type: "approval.decided",
    payload: {
      approvalId: "appr_allow1",
      decision: "approved",
      decidedBy: "usr_abc123",
      reason: "User approved",
    },
  });
}

function baseEnvelope(type: string, sequence: number) {
  return {
    eventId: `evt_${sequence.toString().padStart(6, "0")}` as EventId,
    threadId: "thr_abc123",
    runId,
    workspaceId: "wrk_abc123",
    scopeType: "run",
    scopeId: runId,
    sequence,
    cursor: `cursor_${sequence.toString().padStart(6, "0")}` as EventCursor,
    idempotencyKey: `${runId}:${type}:${sequence}`,
    createdAt: timestamp,
    producer: { kind: "runtime_kernel", id: "kernel" },
    schemaVersion: EVENT_SCHEMA_VERSION,
  };
}

function createRunRow(params: readonly SqlValue[]): RunProjectionRow {
  return {
    run_id: readStringParam(params[0], "run_id"),
    thread_id: readStringParam(params[1], "thread_id"),
    user_id: readStringParam(params[2], "user_id"),
    workspace_id: readStringParam(params[3], "workspace_id"),
    status: readStringParam(params[4], "status"),
    mode: readStringParam(params[5], "mode"),
    provider_id: readStringParam(params[6], "provider_id"),
    model_id: readStringParam(params[7], "model_id"),
    worker_id: readStringParam(params[8], "worker_id"),
    permission_profile_id: readStringParam(params[9], "permission_profile_id"),
    started_at: readNullableStringParam(params[10], "started_at"),
    completed_at: readNullableStringParam(params[11], "completed_at"),
    created_at: readStringParam(params[12], "created_at"),
    updated_at: readStringParam(params[13], "updated_at"),
    last_event_sequence: readNumberParam(params[14], "last_event_sequence"),
    last_cursor: readStringParam(params[15], "last_cursor"),
    projection_version: readNumberParam(params[16], "projection_version"),
  };
}

function createRunItemRow(params: readonly SqlValue[]): RunItemProjectionRow {
  return {
    item_id: readStringParam(params[0], "item_id"),
    run_id: readStringParam(params[1], "run_id"),
    thread_id: readStringParam(params[2], "thread_id"),
    turn_id: readStringParam(params[3], "turn_id"),
    parent_item_id: readNullableStringParam(params[4], "parent_item_id"),
    branch_id: readNullableStringParam(params[5], "branch_id"),
    role: readStringParam(params[6], "role"),
    item_type: readStringParam(params[7], "item_type"),
    status: readStringParam(params[8], "status"),
    content_json: JSON.parse(readStringParam(params[9], "content_json")),
    created_at: readStringParam(params[10], "created_at"),
    completed_at: readNullableStringParam(params[11], "completed_at"),
    event_sequence: readNumberParam(params[12], "event_sequence"),
  };
}

function createToolCallRow(params: readonly SqlValue[]): ToolCallProjectionRow {
  return {
    tool_call_id: readStringParam(params[0], "tool_call_id"),
    run_id: readStringParam(params[1], "run_id"),
    thread_id: readStringParam(params[2], "thread_id"),
    item_id: readStringParam(params[3], "item_id"),
    tool_name: readStringParam(params[4], "tool_name"),
    status: readStringParam(params[5], "status"),
    input_json: JSON.parse(readStringParam(params[6], "input_json")),
    output_json: parseNullableJsonParam(params[7], "output_json"),
    output_text: readStringParam(params[8], "output_text"),
    failure_json: parseNullableJsonParam(params[9], "failure_json"),
    requested_at: readStringParam(params[10], "requested_at"),
    started_at: readNullableStringParam(params[11], "started_at"),
    completed_at: readNullableStringParam(params[12], "completed_at"),
    event_sequence: readNumberParam(params[13], "event_sequence"),
  };
}

function createApprovalRow(params: readonly SqlValue[]): ApprovalProjectionRow {
  return {
    approval_id: readStringParam(params[0], "approval_id"),
    run_id: readStringParam(params[1], "run_id"),
    thread_id: readStringParam(params[2], "thread_id"),
    item_id: readNullableStringParam(params[3], "item_id"),
    status: readStringParam(params[4], "status"),
    question: readStringParam(params[5], "question"),
    options_json: JSON.parse(readStringParam(params[6], "options_json")),
    metadata_json: JSON.parse(readStringParam(params[7], "metadata_json")),
    decision: readNullableStringParam(params[8], "decision"),
    decided_by: readNullableStringParam(params[9], "decided_by"),
    reason: readNullableStringParam(params[10], "reason"),
    requested_at: readStringParam(params[11], "requested_at"),
    decided_at: readNullableStringParam(params[12], "decided_at"),
    event_sequence: readNumberParam(params[13], "event_sequence"),
  };
}

function parseNullableJsonParam(
  value: SqlValue | undefined,
  label: string,
): unknown | null {
  if (value === null) {
    return null;
  }
  return JSON.parse(readStringParam(value, label));
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

const queuedRun = {
  id: runId,
  threadId: "thr_abc123",
  userId: "usr_abc123",
  workspaceId: "wrk_abc123",
  status: "queued",
  mode: "auto_edit",
  providerId: "openrouter",
  modelId: "z-ai/glm-4.5-air:free",
  workerId: "worker_abc123",
  permissionProfileId: "perm_abc123",
  startedAt: null,
  completedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSequence: 1,
};

const assistantItem = {
  id: "itm_asst001",
  threadId: "thr_abc123",
  runId,
  turnId: "trn_abc123",
  parentItemId: null,
  branchId: null,
  role: "assistant",
  status: "running",
  createdAt: timestamp,
  completedAt: null,
  eventSequence: 1,
  type: "assistant_message",
  content: { text: "" },
};
