import {
  EVENT_SCHEMA_VERSION,
  PlatformEventSchema,
  type EventCursor,
  type EventId,
  type PlatformEvent,
  type RunId,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import { projectRunEvents } from "./RunProjectionProjector.js";
import { RunProjectionError, type RunProjectionEventInput } from "./types.js";

const timestamp = "2026-06-09T12:00:00.000Z";
const runId = "run_abc123" as RunId;

describe("RunProjectionProjector", () => {
  it("rebuilds run status from lifecycle events", () => {
    const snapshot = projectRunEvents(runId, [
      projectionInput(createRunEvent("run.created", queuedRun, 1), 1),
      projectionInput(createRunEvent("run.started", runningRun, 2), 2),
      projectionInput(createRunEvent("run.completed", completedRun, 3), 3),
    ]);

    expect(snapshot?.run).toMatchObject({
      id: runId,
      status: "completed",
      startedAt: timestamp,
      completedAt: "2026-06-09T12:03:00.000Z",
      lastEventSequence: 3,
    });
    expect(snapshot?.lastCursor).toBe("cursor_000003");
  });

  it("replays run items and assistant text deterministically", () => {
    const snapshot = projectRunEvents(runId, [
      projectionInput(createRunEvent("run.created", queuedRun, 1), 1),
      projectionInput(createItemEvent("item.started", assistantItem, 2), 2),
      projectionInput(createAssistantTextDeltaEvent("Hello", 3), 3),
      projectionInput(createAssistantTextDeltaEvent(" world", 4), 4),
      projectionInput(createAssistantTextCompletedEvent("Hello world", 5), 5),
    ]);

    expect(snapshot?.items).toHaveLength(1);
    expect(snapshot?.items[0]).toMatchObject({
      id: "itm_asst001",
      type: "assistant_message",
      content: { text: "Hello world" },
      eventSequence: 5,
    });
  });

  it("replays tool call lifecycle with deltas and final output", () => {
    const snapshot = projectRunEvents(runId, [
      projectionInput(createRunEvent("run.created", queuedRun, 1), 1),
      projectionInput(createToolRequestedEvent(2), 2),
      projectionInput(createToolStartedEvent(3), 3),
      projectionInput(createToolDeltaEvent("line 1\n", 4), 4),
      projectionInput(createToolDeltaEvent("line 2\n", 5), 5),
      projectionInput(createToolCompletedEvent(6), 6),
    ]);

    expect(snapshot?.toolCalls).toHaveLength(1);
    expect(snapshot?.toolCalls[0]).toMatchObject({
      toolCallId: "toolcall_read01",
      status: "completed",
      outputText: "line 1\nline 2\n",
      output: { text: "done" },
      eventSequence: 6,
    });
  });

  it("replays approval lifecycle", () => {
    const snapshot = projectRunEvents(runId, [
      projectionInput(createRunEvent("run.created", queuedRun, 1), 1),
      projectionInput(createApprovalRequestedEvent(2), 2),
      projectionInput(createApprovalDecidedEvent(3), 3),
    ]);

    expect(snapshot?.approvals).toHaveLength(1);
    expect(snapshot?.approvals[0]).toMatchObject({
      approvalId: "appr_allow1",
      status: "decided",
      decision: "approved",
      decidedBy: "usr_abc123",
      eventSequence: 3,
    });
  });

  it("fails fast when tool completion has no request", () => {
    expect(() =>
      projectRunEvents(runId, [
        projectionInput(createRunEvent("run.created", queuedRun, 1), 1),
        projectionInput(createToolCompletedEvent(2), 2),
      ]),
    ).toThrow(RunProjectionError);
  });

  it("rejects non-run scoped events", () => {
    expect(() =>
      projectRunEvents(runId, [
        projectionInput(createWorkspaceEvent(1), 1),
      ]),
    ).toThrow(RunProjectionError);
  });
});

function projectionInput(
  event: PlatformEvent,
  projectionSequence: number,
): RunProjectionEventInput {
  return { event, projectionSequence };
}

function createRunEvent(
  type:
    | "run.created"
    | "run.started"
    | "run.completed"
    | "run.cancelled",
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

function createAssistantTextDeltaEvent(
  delta: string,
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("assistant.text.delta", sequence),
    type: "assistant.text.delta",
    payload: {
      itemId: "itm_asst001",
      delta,
    },
  });
}

function createAssistantTextCompletedEvent(
  text: string,
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("assistant.text.completed", sequence),
    type: "assistant.text.completed",
    payload: {
      itemId: "itm_asst001",
      text,
    },
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

function createToolStartedEvent(sequence: number): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("tool.call.started", sequence),
    type: "tool.call.started",
    payload: {
      itemId: "itm_tool001",
      toolCallId: "toolcall_read01",
    },
  });
}

function createToolDeltaEvent(delta: string, sequence: number): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("tool.call.output.delta", sequence),
    type: "tool.call.output.delta",
    payload: {
      itemId: "itm_tool001",
      toolCallId: "toolcall_read01",
      delta,
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
      options: [
        {
          id: "approve",
          label: "Approve",
          description: null,
        },
      ],
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

function createWorkspaceEvent(sequence: number): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("workspace.ready", sequence),
    scopeType: "workspace",
    scopeId: "wrk_abc123",
    type: "workspace.ready",
    payload: { workspaceId: "wrk_abc123" },
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
    createdAt: sequence === 3 ? "2026-06-09T12:03:00.000Z" : timestamp,
    producer: { kind: "runtime_kernel", id: "kernel" },
    schemaVersion: EVENT_SCHEMA_VERSION,
  };
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

const runningRun = {
  ...queuedRun,
  status: "running",
  startedAt: timestamp,
  updatedAt: "2026-06-09T12:01:00.000Z",
};

const completedRun = {
  ...runningRun,
  status: "completed",
  completedAt: "2026-06-09T12:03:00.000Z",
  updatedAt: "2026-06-09T12:03:00.000Z",
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
