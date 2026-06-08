import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  PlatformEventSchema,
  PlatformEventTypeSchema,
  RunEventSchema,
  ThreadEventSchema,
} from "./events.js";

const timestamp = "2026-06-08T15:00:00.000Z";

const envelope = {
  eventId: "evt_abc123",
  threadId: "thr_abc123",
  runId: "run_abc123",
  sequence: 1,
  cursor: "cursor_abc123",
  idempotencyKey: "run_abc123:1",
  createdAt: timestamp,
  producer: {
    kind: "runtime_kernel",
    id: "kernel",
  },
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

const thread = {
  id: "thr_abc123",
  userId: "usr_abc123",
  workspaceId: "wrk_abc123",
  title: "Rebuild thread",
  titleSource: "user",
  status: "active",
  pinnedAt: null,
  archivedAt: null,
  activeRunId: "run_abc123",
  activeLeafItemId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSequence: 1,
};

describe("platform event schemas", () => {
  it("exports the canonical event type contract", () => {
    expect(PlatformEventTypeSchema.options).toMatchInlineSnapshot(`
      [
        "thread.created",
        "run.created",
        "run.started",
        "run.completed",
        "run.failed",
        "run.cancelled",
        "turn.started",
        "turn.completed",
        "turn.failed",
        "assistant.text.delta",
        "assistant.text.completed",
        "item.started",
        "item.updated",
        "item.completed",
        "tool.call.requested",
        "tool.call.started",
        "tool.call.output.delta",
        "tool.call.completed",
        "tool.call.failed",
        "approval.requested",
        "approval.decided",
        "workspace.preparing",
        "workspace.ready",
        "workspace.dirty",
        "workspace.failed",
        "git.status.updated",
        "git.diff.updated",
        "artifact.created",
        "context.compacted",
      ]
    `);
  });

  it("accepts thread events with envelope version, idempotency, sequence, and cursor", () => {
    const event = ThreadEventSchema.parse({
      ...envelope,
      runId: null,
      type: "thread.created",
      payload: { thread },
    });

    expect(event.schemaVersion).toBe(1);
    expect(event.cursor).toBe("cursor_abc123");
  });

  it("requires run IDs for run-scoped events", () => {
    expect(() =>
      RunEventSchema.parse({
        ...envelope,
        runId: null,
        type: "run.started",
        payload: { run },
      }),
    ).toThrow();
  });

  it("rejects malformed envelope metadata", () => {
    expect(() =>
      PlatformEventSchema.parse({
        ...envelope,
        idempotencyKey: "run 1",
        type: "run.created",
        payload: { run },
      }),
    ).toThrow();
    expect(() =>
      PlatformEventSchema.parse({
        ...envelope,
        type: "run.created",
        payload: { run },
        schemaVersion: 2,
      }),
    ).toThrow();
  });

  it("enforces typed tool call payloads through the event boundary", () => {
    expect(() =>
      PlatformEventSchema.parse({
        ...envelope,
        type: "tool.call.requested",
        payload: {
          itemId: "itm_abc123",
          content: {},
        },
      }),
    ).toThrow();

    const event = PlatformEventSchema.parse({
      ...envelope,
      type: "tool.call.requested",
      payload: {
        itemId: "itm_abc123",
        content: {
          toolCallId: "toolcall_abc123",
          toolName: "read_file",
          input: { path: "packages/platform-protocol/src/events.ts" },
        },
      },
    });

    expect(event.type).toBe("tool.call.requested");
  });

  it("rejects non-JSON tool outputs", () => {
    expect(() =>
      PlatformEventSchema.parse({
        ...envelope,
        type: "tool.call.completed",
        payload: {
          itemId: "itm_abc123",
          toolCallId: "toolcall_abc123",
          output: { completedAt: new Date(timestamp) },
        },
      }),
    ).toThrow();
  });
});
