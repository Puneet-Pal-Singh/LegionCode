import { describe, expect, it } from "vitest";
import {
  ArtifactReferenceItemContentSchema,
  JsonRecordSchema,
  RunItemSchema,
  RunSchema,
  ThreadItemSchema,
  ThreadSchema,
  ToolCallItemContentSchema,
  TurnSchema,
} from "./conversation.js";

const timestamp = "2026-06-08T15:00:00.000Z";

describe("conversation protocol schemas", () => {
  it("accepts a durable thread projection shape", () => {
    const thread = ThreadSchema.parse({
      id: "thr_abc123",
      userId: "usr_abc123",
      workspaceId: "wrk_abc123",
      title: "Rebuild thread",
      titleSource: "user",
      status: "active",
      pinnedAt: null,
      archivedAt: null,
      activeRunId: "run_abc123",
      activeLeafItemId: "itm_abc123",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastEventSequence: 7,
    });

    expect(thread.activeRunId).toBe("run_abc123");
  });

  it("accepts a run with provider, model, worker, and permission snapshots", () => {
    const run = RunSchema.parse({
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
      lastEventSequence: 3,
    });

    expect(run.status).toBe("running");
  });

  it("keeps turns distinct from threads and runs", () => {
    const turn = TurnSchema.parse({
      id: "trn_abc123",
      threadId: "thr_abc123",
      runId: "run_abc123",
      parentTurnId: null,
      status: "completed",
      startedAt: timestamp,
      completedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastEventSequence: 10,
    });

    expect(turn.id).toBe("trn_abc123");
  });

  it("supports item parent and branch fields without requiring branching UI", () => {
    const item = ThreadItemSchema.parse({
      id: "itm_abc123",
      threadId: "thr_abc123",
      runId: null,
      turnId: null,
      parentItemId: "itm_parent123",
      branchId: "mainline",
      type: "user_message",
      role: "user",
      status: "completed",
      content: { text: "Implement the next protocol slice." },
      createdAt: timestamp,
      completedAt: timestamp,
      eventSequence: 1,
    });

    expect(item.parentItemId).toBe("itm_parent123");
    expect(item.branchId).toBe("mainline");
  });

  it("requires run and turn IDs for run items", () => {
    expect(() =>
      RunItemSchema.parse({
        id: "itm_abc123",
        threadId: "thr_abc123",
        runId: null,
        turnId: null,
        parentItemId: null,
        branchId: null,
        type: "tool_call",
        role: "assistant",
        status: "running",
        content: {},
        createdAt: timestamp,
        completedAt: null,
        eventSequence: 2,
      }),
    ).toThrow();
  });

  it("rejects non-JSON protocol payloads", () => {
    expect(() =>
      JsonRecordSchema.parse({
        createdAt: new Date(timestamp),
      }),
    ).toThrow();
    expect(() =>
      JsonRecordSchema.parse({
        missing: undefined,
      }),
    ).toThrow();
    expect(() =>
      JsonRecordSchema.parse({
        unsafeNumber: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();
  });

  it("accepts typed content for tool calls and artifact references", () => {
    const toolCallContent = ToolCallItemContentSchema.parse({
      toolCallId: "toolcall_abc123",
      toolName: "read_file",
      input: { path: "packages/platform-protocol/src/conversation.ts" },
    });
    const artifactReferenceContent =
      ArtifactReferenceItemContentSchema.parse({
        artifactId: "art_abc123",
        label: "Diff preview",
        metadata: { mimeType: "text/x-diff" },
      });

    expect(toolCallContent.toolName).toBe("read_file");
    expect(artifactReferenceContent.label).toBe("Diff preview");
  });

  it("enforces typed content through the thread item boundary", () => {
    expect(() =>
      ThreadItemSchema.parse({
        id: "itm_abc123",
        threadId: "thr_abc123",
        runId: "run_abc123",
        turnId: "trn_abc123",
        parentItemId: null,
        branchId: null,
        type: "tool_call",
        role: "assistant",
        status: "running",
        content: {},
        createdAt: timestamp,
        completedAt: null,
        eventSequence: 2,
      }),
    ).toThrow();

    const item = ThreadItemSchema.parse({
      id: "itm_abc123",
      threadId: "thr_abc123",
      runId: "run_abc123",
      turnId: "trn_abc123",
      parentItemId: null,
      branchId: null,
      type: "artifact_reference",
      role: "runtime",
      status: "completed",
      content: {
        artifactId: "art_abc123",
        label: "Patch",
        metadata: { mimeType: "text/x-diff" },
      },
      createdAt: timestamp,
      completedAt: timestamp,
      eventSequence: 3,
    });

    expect(item.type).toBe("artifact_reference");
    if (item.type !== "artifact_reference") {
      throw new Error("Expected artifact reference item");
    }
    expect(item.content.artifactId).toBe("art_abc123");
  });

  it("rejects extra fields at the protocol boundary", () => {
    expect(() =>
      ThreadSchema.parse({
        id: "thr_abc123",
        userId: "usr_abc123",
        workspaceId: "wrk_abc123",
        title: "Thread",
        titleSource: "generated",
        status: "active",
        pinnedAt: null,
        archivedAt: null,
        activeRunId: null,
        activeLeafItemId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastEventSequence: 0,
        sessionId: "run_abc123",
      }),
    ).toThrow();
  });

  it("rejects unsafe event sequence values", () => {
    expect(() =>
      ThreadSchema.parse({
        id: "thr_abc123",
        userId: "usr_abc123",
        workspaceId: "wrk_abc123",
        title: "Thread",
        titleSource: "generated",
        status: "active",
        pinnedAt: null,
        archivedAt: null,
        activeRunId: null,
        activeLeafItemId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastEventSequence: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });
});
