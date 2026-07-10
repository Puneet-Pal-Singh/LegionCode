import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_PART_KINDS,
  RUN_EVENT_TYPES,
  TOOL_ACTIVITY_FAMILIES,
} from "@repo/shared-types";
import {
  PermissionApprovalStore,
  Run,
  RunEventRecorder,
  RunEventRepository,
  RunRepository,
  type RuntimeDurableObjectState,
  type RuntimeStorage,
  createRunCompletedEvent,
  createToolCompletedEvent,
  createToolRequestedEvent,
  createToolStartedEvent,
  tagRuntimeStateSemantics,
} from "@shadowbox/execution-engine/runtime";
import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Env } from "../types/ai";
import { CloudflareEventStreamAdapter } from "./adapters/CloudflareEventStreamAdapter";
import {
  RunEngineRequestHandler,
  type CanonicalRunEventSink,
} from "./RunEngineRequestHandler";

describe("RunEngineRequestHandler", () => {
  it("serves run-engine runtime debug metadata with run-engine headers", async () => {
    const ctx = new MockDurableObjectState();
    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {
        RUNTIME_GIT_SHA: "run-engine-sha",
      } as Env,
      runImmediately,
    );

    const response = await handler.handleRuntimeDebugRequest(
      new Request("https://run-engine/debug/runtime"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Shadowbox-Runtime-Name")).toBe(
      "brain-run-engine-do",
    );
    expect(response.headers.get("X-Shadowbox-Runtime-Fingerprint")).toContain(
      "brain-run-engine-do:run-engine-sha:",
    );

    const body = (await response.json()) as {
      runtime: { name: string; gitSha: string };
    };
    expect(body.runtime.name).toBe("brain-run-engine-do");
    expect(body.runtime.gitSha).toBe("run-engine-sha");
  });

  it("projects summary counts from canonical runtime events", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);
    const eventRepo = new RunEventRepository(runtimeState);

    await runRepo.create(
      new Run(
        "run_123e4567e89b42d3a456426614174000",
        "session-1",
        "RUNNING",
        "coding",
        {
          agentType: "coding",
          prompt: "read README.md and run tests",
          sessionId: "session-1",
        },
      ),
    );

    const toolInput = {
      runId: "run_123e4567e89b42d3a456426614174000",
      sessionId: "session-1",
    };
    await eventRepo.append(
      toolInput.runId,
      createToolRequestedEvent(
        {
          ...toolInput,
          taskId: "task-1",
          toolName: "read_file",
        },
        { path: "README.md" },
      ),
    );
    await eventRepo.append(
      toolInput.runId,
      createToolStartedEvent({
        ...toolInput,
        taskId: "task-1",
        toolName: "read_file",
      }),
    );
    await eventRepo.append(
      toolInput.runId,
      createToolCompletedEvent(
        {
          ...toolInput,
          taskId: "task-1",
          toolName: "read_file",
        },
        "README contents",
        8,
      ),
    );
    await eventRepo.append(
      toolInput.runId,
      createToolRequestedEvent(
        {
          ...toolInput,
          taskId: "task-2",
          toolName: "bash",
        },
        { command: "pnpm test" },
      ),
    );

    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      { canonicalEventSink: createNoopCanonicalEventSink() },
    );

    const response = await handler.handleSummaryRequest(
      new Request(
        "https://brain.local/summary?runId=run_123e4567e89b42d3a456426614174000",
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      totalTasks: number;
      completedTasks: number;
      failedTasks: number;
      runningTasks: number;
      pendingTasks: number;
      eventCount: number;
      lastEventType: string | null;
    };

    expect(body.totalTasks).toBe(2);
    expect(body.completedTasks).toBe(1);
    expect(body.runningTasks).toBe(0);
    expect(body.pendingTasks).toBe(1);
    expect(body.failedTasks).toBe(0);
    expect(body.eventCount).toBe(4);
    expect(body.lastEventType).toBe("tool.requested");
  });

  it("includes persisted plan artifacts in the summary response", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);

    const run = new Run(
      "run_123e4567e89b42d3a456426614174002",
      "session-1",
      "COMPLETED",
      "coding",
      {
        agentType: "coding",
        mode: "plan",
        prompt: "plan the migration",
        sessionId: "session-1",
      },
    );
    run.metadata.planArtifact = {
      id: `${run.id}:plan`,
      createdAt: "2026-03-24T10:00:00.000Z",
      summary: "Inspect the repository before executing the build flow.",
      estimatedSteps: 2,
      tasks: [],
      handoff: {
        targetMode: "build",
        summary: "Move to build with the approved handoff prompt.",
        prompt: "Execute this approved plan in build mode.",
      },
    };
    await runRepo.create(run);

    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      { canonicalEventSink: createNoopCanonicalEventSink() },
    );

    const response = await handler.handleSummaryRequest(
      new Request(
        `https://brain.local/summary?runId=${encodeURIComponent(run.id)}`,
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      planArtifact?: {
        handoff?: {
          prompt?: string;
          targetMode?: string;
        };
      } | null;
    };

    expect(body.planArtifact?.handoff?.targetMode).toBe("build");
    expect(body.planArtifact?.handoff?.prompt).toBe(
      "Execute this approved plan in build mode.",
    );
  });

  it("includes terminal message metadata in the summary response", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);

    const run = new Run(
      "run_123e4567e89b42d3a456426614174003",
      "session-1",
      "COMPLETED",
      "coding",
      {
        agentType: "coding",
        prompt: "ship the UI fix",
        sessionId: "session-1",
      },
    );
    run.metadata.terminalState = "completed";
    run.metadata.terminalMessage = {
      terminalState: "completed",
      changedFileCount: 2,
      lastSuccessfulStep: "create_code_artifact",
      nextAction: "Send the next task when ready.",
    };
    await runRepo.create(run);

    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
    );

    const response = await handler.handleSummaryRequest(
      new Request(
        `https://brain.local/summary?runId=${encodeURIComponent(run.id)}`,
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      terminalState: "completed",
      terminalMessage: {
        changedFileCount: 2,
        lastSuccessfulStep: "create_code_artifact",
      },
    });
  });

  it("streams canonical runtime events as NDJSON", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const eventRepo = new RunEventRepository(runtimeState);
    const runId = "run_123e4567e89b42d3a456426614174001";

    await eventRepo.append(
      runId,
      createToolRequestedEvent(
        {
          runId,
          sessionId: "session-1",
          taskId: "task-1",
          toolName: "read_file",
        },
        { path: "README.md" },
      ),
    );
    await eventRepo.append(
      runId,
      createToolCompletedEvent(
        {
          runId,
          sessionId: "session-1",
          taskId: "task-1",
          toolName: "read_file",
        },
        "README contents",
        8,
      ),
    );

    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
    );

    const response = await handler.handleEventsRequest(
      new Request(`https://brain.local/events?runId=${runId}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );

    const lines = (await response.text()).trim().split("\n");
    expect(lines).toHaveLength(2);

    const firstEvent = JSON.parse(lines[0]) as { type: string; runId: string };
    const secondEvent = JSON.parse(lines[1]) as { type: string; runId: string };
    expect(firstEvent.type).toBe(RUN_EVENT_TYPES.TOOL_REQUESTED);
    expect(secondEvent.type).toBe(RUN_EVENT_TYPES.TOOL_COMPLETED);
    expect(firstEvent.runId).toBe(runId);
    expect(secondEvent.runId).toBe(runId);
  });

  it("streams events emitted after the event stream endpoint connects", async () => {
    const ctx = new MockDurableObjectState();
    const runId = "run_123e4567e89b42d3a456426614174111";
    const eventStream = new CloudflareEventStreamAdapter();
    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      eventStream,
      { canonicalEventSink: createNoopCanonicalEventSink() },
    );

    const response = await handler.handleEventsStreamRequest(
      new Request(`https://brain.local/events/stream?runId=${runId}`),
    );
    eventStream.emit(
      createToolRequestedEvent(
        {
          runId,
          sessionId: "session-1",
          taskId: "task-live",
          toolName: "read_file",
        },
        { path: "README.md" },
      ),
    );
    eventStream.complete(runId);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('"toolName":"read_file"');
  });

  it("streams the canonical cancellation event to connected clients", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);
    const runId = "run_123e4567e89b42d3a456426614174211";
    await runRepo.create(
      new Run(runId, "session-1", "RUNNING", "coding", {
        agentType: "coding",
        prompt: "cancel this run",
        sessionId: "session-1",
      }),
    );

    const eventStream = new CloudflareEventStreamAdapter();
    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      eventStream,
      { canonicalEventSink: createNoopCanonicalEventSink() },
    );

    const streamResponse = await handler.handleEventsStreamRequest(
      new Request(`https://brain.local/events/stream?runId=${runId}`),
    );
    const cancelResponse = await handler.handleCancelRequest(
      new Request("https://brain.local/cancel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runId }),
      }),
    );

    expect(cancelResponse.status).toBe(200);
    await expect(streamResponse.text()).resolves.toContain(
      `"type":"${RUN_EVENT_TYPES.RUN_STATUS_CHANGED}"`,
    );
  });

  it("does not queue cancel behind the execution lock", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);
    const runId = "run_123e4567e89b42d3a456426614174212";
    await runRepo.create(
      new Run(runId, "session-1", "RUNNING", "coding", {
        agentType: "coding",
        prompt: "cancel this run",
        sessionId: "session-1",
      }),
    );

    const withExecutionLock = vi.fn(runImmediately);
    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      withExecutionLock,
      undefined,
      { canonicalEventSink: createNoopCanonicalEventSink() },
    );

    const cancelResponse = await handler.handleCancelRequest(
      new Request("https://brain.local/cancel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runId }),
      }),
    );

    expect(cancelResponse.status).toBe(200);
    expect(withExecutionLock).not.toHaveBeenCalled();
  });

  it("projects a typed activity feed snapshot", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);
    const eventRepo = new RunEventRepository(runtimeState);
    const runId = "run_123e4567e89b42d3a456426614174099";

    const run = new Run(runId, "session-1", "COMPLETED", "coding", {
      agentType: "coding",
      mode: "plan",
      prompt: "Inspect and hand off",
      sessionId: "session-1",
    });
    run.metadata.lifecycleSteps = [
      {
        step: "APPROVAL_WAIT",
        recordedAt: "2026-03-24T10:00:00.000Z",
        detail: "platform approval required",
      },
    ];
    run.metadata.planArtifact = {
      id: `${run.id}:plan`,
      createdAt: "2026-03-24T10:00:02.000Z",
      summary: "Inspect and then execute the build flow.",
      estimatedSteps: 2,
      tasks: [],
      handoff: {
        targetMode: "build",
        summary: "Move to build with the approved handoff prompt.",
        prompt: "Execute this approved plan in build mode.",
      },
    };
    await runRepo.create(run);

    await eventRepo.append(
      runId,
      createToolRequestedEvent(
        {
          runId,
          sessionId: "session-1",
          taskId: "task-1",
          toolName: "bash",
        },
        { command: "pnpm test" },
      ),
    );
    await eventRepo.append(
      runId,
      createToolCompletedEvent(
        {
          runId,
          sessionId: "session-1",
          taskId: "task-1",
          toolName: "bash",
        },
        { content: "ok" },
        8,
      ),
    );
    await eventRepo.append(
      runId,
      createRunCompletedEvent(
        {
          runId,
          sessionId: "session-1",
        },
        12,
        1,
      ),
    );

    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      { canonicalEventSink: createNoopCanonicalEventSink() },
    );

    const response = await handler.handleActivityRequest(
      new Request(`https://brain.local/activity?runId=${runId}`),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string | null;
      items: Array<{
        kind: string;
        metadata?: { family?: string; command?: string };
      }>;
    };

    expect(body.status).toBe("COMPLETED");
    expect(
      body.items.some((item) => item.kind === ACTIVITY_PART_KINDS.APPROVAL),
    ).toBe(true);
    expect(
      body.items.some(
        (item) =>
          item.kind === ACTIVITY_PART_KINDS.TOOL &&
          item.metadata?.family === TOOL_ACTIVITY_FAMILIES.SHELL &&
          item.metadata.command === "pnpm test",
      ),
    ).toBe(true);
  });

  it("resolves pending approvals through the approval endpoint and emits approval.resolved", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);
    const eventRepo = new RunEventRepository(runtimeState);
    const runId = "run_123e4567e89b42d3a456426614174333";
    const run = new Run(runId, "session-1", "RUNNING", "coding", {
      agentType: "coding",
      prompt: "commit changes",
      sessionId: "session-1",
    });
    await runRepo.create(run);

    const approvalStore = new PermissionApprovalStore(runtimeState, runId);
    await approvalStore.setPendingRequest({
      requestId: "req-1",
      runId,
      origin: "agent",
      category: "git_mutation",
      title: "Commit changes",
      reason: "Git mutation actions can change repository history.",
      actionFingerprint: "git:commit",
      availableDecisions: ["allow_once", "deny"],
      createdAt: "2026-03-24T10:00:00.000Z",
    });

    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      { canonicalEventSink: createNoopCanonicalEventSink() },
    );

    const response = await handler.handleApprovalRequest(
      new Request("https://brain.local/approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runId,
          requestId: "req-1",
          decision: "allow_once",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      decision: string;
      pendingApproval: unknown;
    };
    expect(body.status).toBe("approved");
    expect(body.decision).toBe("allow_once");
    expect(body.pendingApproval).toBeNull();

    const events = await eventRepo.getByRun(runId);
    expect(
      events.some(
        (event) =>
          event.type === RUN_EVENT_TYPES.APPROVAL_RESOLVED &&
          event.payload.requestId === "req-1",
      ),
    ).toBe(true);
  });

  it("returns conflict when resolving approval without a matching pending request", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);
    const runId = "run_123e4567e89b42d3a456426614174334";
    await runRepo.create(
      new Run(runId, "session-1", "RUNNING", "coding", {
        agentType: "coding",
        prompt: "commit changes",
        sessionId: "session-1",
      }),
    );

    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      { canonicalEventSink: createNoopCanonicalEventSink() },
    );

    const response = await handler.handleApprovalRequest(
      new Request("https://brain.local/approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runId,
          requestId: "missing",
          decision: "deny",
        }),
      }),
    );

    expect(response.status).toBe(409);
    const eventRepo = new RunEventRepository(runtimeState);
    const events = await eventRepo.getByRun(runId);
    expect(
      events.some(
        (event) =>
          event.type === RUN_EVENT_TYPES.RUN_PROGRESS &&
          event.payload.label === "Approval decision ignored",
      ),
    ).toBe(true);
  });

  it("keeps approval error mapping when progress telemetry fails", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);
    const runId = "run_123e4567e89b42d3a456426614174335";
    await runRepo.create(
      new Run(runId, "session-1", "RUNNING", "coding", {
        agentType: "coding",
        prompt: "commit changes",
        sessionId: "session-1",
      }),
    );

    const recordRunProgressSpy = vi
      .spyOn(RunEventRecorder.prototype, "recordRunProgress")
      .mockRejectedValueOnce(new Error("event persistence unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const handler = new RunEngineRequestHandler(
        ctx as unknown as DurableObjectState,
        {} as Env,
        runImmediately,
      );

      const response = await handler.handleApprovalRequest(
        new Request("https://brain.local/approval", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            runId,
            requestId: "missing",
            decision: "deny",
          }),
        }),
      );

      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("No pending approval request");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[run/approval] failed to record ignored approval decision:",
        ),
      );
    } finally {
      recordRunProgressSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

async function runImmediately<T>(
  _runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return await operation();
}

function createNoopCanonicalEventSink(): CanonicalRunEventSink {
  return {
    async persist() {
      return;
    },
  };
}

class InMemoryStorage implements RuntimeStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const entry of key) {
        if (this.values.delete(entry)) {
          deleted += 1;
        }
      }
      return deleted;
    }
    return this.values.delete(key);
  }

  async list<T>(options?: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const results = new Map<string, T>();

    for (const [key, value] of this.values.entries()) {
      if (options?.prefix && !key.startsWith(options.prefix)) {
        continue;
      }
      if (options?.start && key < options.start) {
        continue;
      }
      if (options?.end && key >= options.end) {
        continue;
      }

      results.set(key, value as T);
      if (options?.limit && results.size >= options.limit) {
        break;
      }
    }

    return results;
  }
}

class MockDurableObjectState implements RuntimeDurableObjectState {
  storage = new InMemoryStorage();

  async blockConcurrencyWhile<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
