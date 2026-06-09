import { describe, expect, it } from "vitest";
import {
  ApprovalEventSchema,
  ArtifactEventSchema,
  EVENT_SCHEMA_VERSION,
  EventScopeSchema,
  EventScopeTypeSchema,
  PlatformEventSchema,
  PlatformEventTypeSchema,
  RunEventSchema,
  ThreadEventSchema,
  WorkspaceEventSchema,
} from "./events.js";

const timestamp = "2026-06-08T15:00:00.000Z";

const envelope = {
  eventId: "evt_abc123",
  threadId: "thr_abc123",
  runId: "run_abc123",
  workspaceId: "wrk_abc123",
  scopeType: "run",
  scopeId: "run_abc123",
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
    expect(EventScopeTypeSchema.options).toEqual([
      "thread",
      "run",
      "workspace",
      "artifact",
      "provider",
    ]);
    expect(
      EventScopeSchema.parse({
        scopeType: "provider",
        scopeId: "openrouter",
      }),
    ).toEqual({
      scopeType: "provider",
      scopeId: "openrouter",
    });
    expect(() =>
      EventScopeSchema.parse({
        scopeType: "run",
        scopeId: "thr_abc123",
      }),
    ).toThrow();
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
      scopeType: "thread",
      scopeId: "thr_abc123",
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
        scopeId: "run_abc123",
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
    expect(() =>
      PlatformEventSchema.parse({
        ...envelope,
        producer: { kind: "sdk", id: "web-client" },
        type: "run.created",
        payload: { run },
      }),
    ).toThrow();
  });

  it("rejects projection IDs that disagree with the event envelope", () => {
    expect(() =>
      PlatformEventSchema.parse({
        ...envelope,
        type: "run.started",
        payload: {
          run: {
            ...run,
            id: "run_other123",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      ThreadEventSchema.parse({
        ...envelope,
        runId: null,
        scopeType: "thread",
        scopeId: "thr_abc123",
        type: "thread.created",
        payload: {
          thread: {
            ...thread,
            id: "thr_other123",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects scope IDs that disagree with canonical identities", () => {
    expect(() =>
      PlatformEventSchema.parse({
        ...envelope,
        scopeId: "run_other123",
        type: "run.started",
        payload: { run },
      }),
    ).toThrow();

    expect(() =>
      WorkspaceEventSchema.parse({
        ...envelope,
        scopeType: "workspace",
        scopeId: "wrk_other123",
        type: "workspace.ready",
        payload: { workspaceId: "wrk_abc123" },
      }),
    ).toThrow();

    expect(() =>
      ArtifactEventSchema.parse({
        ...envelope,
        scopeType: "artifact",
        scopeId: "art_other123",
        type: "artifact.created",
        payload: {
          itemId: null,
          reference: {
            artifactId: "art_abc123",
            label: "Patch",
            metadata: {},
          },
        },
      }),
    ).toThrow();

    expect(() =>
      ApprovalEventSchema.parse({
        ...envelope,
        scopeId: "run_other123",
        type: "approval.requested",
        payload: {
          approvalId: "appr_abc123",
          itemId: null,
          question: "Allow this action?",
          options: [
            {
              id: "approve",
              label: "Approve",
              description: null,
            },
          ],
          metadata: {},
        },
      }),
    ).toThrow();
  });

  it("rejects workspace attribution that disagrees with canonical payloads", () => {
    expect(() =>
      ThreadEventSchema.parse({
        ...envelope,
        runId: null,
        scopeType: "thread",
        scopeId: "thr_abc123",
        workspaceId: "wrk_other123",
        type: "thread.created",
        payload: { thread },
      }),
    ).toThrow();

    expect(() =>
      PlatformEventSchema.parse({
        ...envelope,
        workspaceId: "wrk_other123",
        type: "run.started",
        payload: { run },
      }),
    ).toThrow();

    expect(() =>
      WorkspaceEventSchema.parse({
        ...envelope,
        scopeType: "workspace",
        scopeId: "wrk_abc123",
        workspaceId: "wrk_other123",
        type: "workspace.ready",
        payload: { workspaceId: "wrk_abc123" },
      }),
    ).toThrow();
  });

  it("keeps workspace and artifact events out of the run event contract", () => {
    expect(() =>
      RunEventSchema.parse({
        ...envelope,
        scopeType: "workspace",
        scopeId: "wrk_abc123",
        type: "workspace.ready",
        payload: { workspaceId: "wrk_abc123" },
      }),
    ).toThrow();

    expect(() =>
      RunEventSchema.parse({
        ...envelope,
        scopeType: "artifact",
        scopeId: "art_abc123",
        type: "artifact.created",
        payload: {
          itemId: null,
          reference: {
            artifactId: "art_abc123",
            label: "Patch",
            metadata: {},
          },
        },
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

  it("uses the canonical typed error envelope for failures", () => {
    const event = PlatformEventSchema.parse({
      ...envelope,
      type: "tool.call.failed",
      payload: {
        itemId: "itm_abc123",
        toolCallId: "toolcall_abc123",
        failure: {
          code: "capability_unsupported",
          message: "The active worker does not support this tool.",
          retryable: false,
          correlationId: "request-123",
          details: {
            capability: "browser",
          },
        },
      },
    });

    if (event.type !== "tool.call.failed") {
      throw new Error("expected tool.call.failed event");
    }
    expect(event.payload.failure.code).toBe("capability_unsupported");
  });

  it("uses the artifact reference as the canonical artifact identity", () => {
    const event = ArtifactEventSchema.parse({
      ...envelope,
      scopeType: "artifact",
      scopeId: "art_abc123",
      type: "artifact.created",
      payload: {
        itemId: null,
        reference: {
          artifactId: "art_abc123",
          label: "Patch",
          metadata: { mimeType: "text/x-diff" },
        },
      },
    });

    expect(event.payload.reference.artifactId).toBe("art_abc123");
  });
});
