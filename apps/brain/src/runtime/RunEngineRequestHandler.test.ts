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
import type { LifecycleEventStore } from "@repo/persistence";
import { TaskCheckoutSchema, TurnIdSchema } from "@repo/platform-protocol";
import type { Env } from "../types/ai";
import { CloudflareEventStreamAdapter } from "./adapters/CloudflareEventStreamAdapter";
import {
  RunEngineRequestHandler,
  type CanonicalRunEventSink,
} from "./RunEngineRequestHandler";
import { RunInterruptIdentitySchema } from "./RunInterruptContract";
import { InMemoryRunInterruptRegistry } from "./RunInterruptRegistry";
import { InMemoryRunApprovalResolutionRegistry } from "./RunApprovalResolutionRegistry";
import type { RunApprovalResolutionRegistry } from "./RunApprovalResolutionRegistry";

describe("RunEngineRequestHandler", () => {
  it("issues one persisted four-id scope before execution starts", async () => {
    const ctx = new MockDurableObjectState();
    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
    );

    const response = await handler.handleTurnStartRequest(
      new Request("https://run-engine/turn/start", {
        method: "POST",
        body: JSON.stringify({
          runId: "run_123456",
          sessionId: "session-1",
          workspaceId: "00000000-0000-4000-8000-000000000001",
          correlationId: "corr-1",
        }),
      }),
    );

    expect(response.status).toBe(201);
    const identity = (await response.json()) as Record<string, string>;
    expect(Object.keys(identity).sort()).toEqual([
      "runAttemptId",
      "threadId",
      "turnId",
      "workspaceId",
    ]);
    expect(identity.workspaceId).toBe("00000000-0000-4000-8000-000000000001");
    expect(identity.threadId).toMatch(/^thr_/);
    expect(identity.turnId).toMatch(/^trn_/);
    expect(identity.runAttemptId).toMatch(/^attempt_/);

    const persisted = await ctx.storage.get("turnRuntimeIdentities");
    expect(persisted).toEqual(
      expect.objectContaining({
        [identity.turnId]: expect.objectContaining(identity),
      }),
    );
  });

  it("issues one turn attempt per client message while preserving thread identity", async () => {
    const handler = new RunEngineRequestHandler(
      new MockDurableObjectState() as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
    );
    const start = (clientMessageId: string) =>
      handler.handleTurnStartRequest(
        new Request("https://run-engine/turn/start", {
          method: "POST",
          body: JSON.stringify({
            runId: "run_123456",
            sessionId: "session-1",
            clientMessageId,
            workspaceId: "00000000-0000-4000-8000-000000000001",
            correlationId: "corr-1",
          }),
        }),
      );

    const firstResponse = await start("client-message-1");
    const first = (await firstResponse.json()) as Record<string, string>;
    const secondResponse = await start("client-message-2");
    const second = (await secondResponse.json()) as Record<string, string>;
    const repeatedResponse = await start("client-message-2");
    const repeated = (await repeatedResponse.json()) as Record<string, string>;

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(repeatedResponse.status).toBe(200);
    expect(second.threadId).toBe(first.threadId);
    expect(second.turnId).not.toBe(first.turnId);
    expect(second.runAttemptId).not.toBe(first.runAttemptId);
    expect(repeated).toEqual(second);
  });

  it("returns the latest server-issued workspace scope for Git callers", async () => {
    const ctx = new MockDurableObjectState();
    const resolveActiveCheckout = vi.fn(async () =>
      TaskCheckoutSchema.parse({
        kind: "task_checkout",
        checkoutId: "checkout_123456",
        snapshotId: "wsnap_123456",
        workspaceId: "wrk_00000000-0000-4000-8000-000000000001",
        threadId: "thr_placeholder",
        turnId: "trn_placeholder",
        runAttemptId: "attempt_placeholder",
        leaseId: "lease_123456",
        sandboxId: "sandbox-123456",
        filesystemRoot: "/home/sandbox/checkouts/checkout_123456",
        gitDir: "/home/sandbox/checkouts/checkout_123456/.git",
        indexFile: "/home/sandbox/checkouts/checkout_123456/.git/index",
        workingBranch: "task/checkout-123456",
        startTreeId: "a".repeat(40),
        generation: 1,
        status: "active",
        settledAt: null,
        failureCode: null,
        createdAt: "2026-07-18T12:00:00.000Z",
      }),
    );
    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      {
        taskCheckoutScopeResolver: { resolveActiveCheckout },
      },
    );

    await handler.handleTurnStartRequest(
      new Request("https://run-engine/turn/start", {
        method: "POST",
        body: JSON.stringify({
          runId: "run_123456",
          sessionId: "session-1",
          workspaceId: "00000000-0000-4000-8000-000000000001",
          correlationId: "corr-1",
        }),
      }),
    );

    const response = await handler.handleWorkspaceScopeRequest(
      new Request("https://run-engine/scope?runId=run_123456"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: "run_123456",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      root: "/home/sandbox/checkouts/checkout_123456",
    });
    expect(resolveActiveCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run_123456",
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }),
      "workspace-scope:run_123456",
    );
  });

  it("rejects workspace scope resolution before turn bootstrap", async () => {
    const handler = new RunEngineRequestHandler(
      new MockDurableObjectState() as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
    );

    const response = await handler.handleWorkspaceScopeRequest(
      new Request("https://run-engine/scope?runId=run_123456"),
    );

    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toMatchObject({
      code: "TURN_SCOPE_REQUIRED",
    });
  });

  it("rejects execution when bootstrap identity is not authorized for the run scope", async () => {
    const handler = new RunEngineRequestHandler(
      new MockDurableObjectState() as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
    );
    const response = await handler.handleExecuteRequest(
      new Request("https://run-engine/execute", {
        method: "POST",
        body: JSON.stringify({
          runId: "run_123456",
          workspaceId: "00000000-0000-4000-8000-000000000001",
          identity: {
            workspaceId: "00000000-0000-4000-8000-000000000001",
            threadId: "thr_123456",
            turnId: "trn_123456",
            runAttemptId: "attempt_123456",
          },
          sessionId: "session-1",
          correlationId: "corr-1",
          input: {
            mode: "build",
            agentType: "coding",
            prompt: "read README",
            sessionId: "session-1",
            orchestratorBackend: "execution-engine-v1",
            executionBackend: "cloudflare_sandbox",
            harnessMode: "platform_owned",
            authMode: "api_key",
          },
          messages: [{ role: "user", content: "read README" }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "TURN_SCOPE_MISMATCH",
    });
  });

  it("rejects execution without a server-issued bootstrap identity", async () => {
    const handler = new RunEngineRequestHandler(
      new MockDurableObjectState() as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
    );
    const response = await handler.handleExecuteRequest(
      new Request("https://run-engine/execute", {
        method: "POST",
        body: JSON.stringify({
          runId: "run_123456",
          workspaceId: "00000000-0000-4000-8000-000000000001",
          sessionId: "session-1",
          correlationId: "corr-1",
          input: {
            mode: "build",
            agentType: "coding",
            prompt: "read README",
            sessionId: "session-1",
            orchestratorBackend: "execution-engine-v1",
            executionBackend: "cloudflare_sandbox",
            harnessMode: "platform_owned",
            authMode: "api_key",
          },
          messages: [{ role: "user", content: "read README" }],
        }),
      }),
    );

    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toMatchObject({
      code: "TURN_BOOTSTRAP_REQUIRED",
    });
  });

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

  it("rejects an interrupt whose canonical identity is not active", async () => {
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

    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      { canonicalEventSink: createNoopCanonicalEventSink() },
    );

    const interruptResponse = await handler.handleInterruptRequest(
      new Request("https://brain.local/interrupt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runId,
          workspaceId: "123e4567-e89b-42d3-a456-426614174111",
          sessionId: "session-123456",
          threadId: "thr_123456",
          turnId: "trn_123456",
          runAttemptId: "attempt_123456",
        }),
      }),
    );

    expect(interruptResponse.status).toBe(409);
  });

  it("dispatches one active interrupt across request-handler instances and replays its terminal settlement", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);
    const identity = RunInterruptIdentitySchema.parse({
      runId: "run_123e4567e89b42d3a456426614174213",
      workspaceId: "123e4567-e89b-42d3-a456-426614174111",
      sessionId: "session-1",
      threadId: "thr_123456",
      turnId: "trn_123456",
      runAttemptId: "attempt_123456",
    });
    await runRepo.create(
      new Run(identity.runId, identity.sessionId, "RUNNING", "coding", {
        agentType: "coding",
        prompt: "interrupt this run",
        sessionId: identity.sessionId,
      }),
    );
    await ctx.storage.put("turnToRunMap", {
      [identity.turnId]: identity.runId,
    });
    await ctx.storage.put("turnRuntimeIdentities", {
      [identity.turnId]: identity,
    });

    const interruptRegistry = new InMemoryRunInterruptRegistry();
    const interrupt = vi.fn().mockResolvedValue(undefined);
    interruptRegistry.register(identity.turnId, interrupt);
    let settled = false;
    const lifecycleEventStore = {
      replay: vi.fn(async () => ({
        events: settled ? ([{ type: "turn.interrupted" }] as unknown[]) : [],
        nextSequence: null,
      })),
    } as unknown as LifecycleEventStore;
    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      { interruptRegistry, lifecycleEventStore },
    );

    const crossThread = RunInterruptIdentitySchema.parse({
      ...identity,
      threadId: "thr_654321",
    });
    const rejected = await handler.handleInterruptRequest(
      interruptRequest(crossThread),
    );

    expect(rejected.status).toBe(409);
    expect(interrupt).not.toHaveBeenCalled();

    const first = await handler.handleInterruptRequest(
      interruptRequest(identity),
    );

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      accepted: true,
      status: "interrupt_requested",
    });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith("User interrupted the turn.");

    settled = true;
    const replayHandler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      { interruptRegistry, lifecycleEventStore },
    );
    const repeated = await replayHandler.handleInterruptRequest(
      interruptRequest(identity),
    );

    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      accepted: false,
      status: "settled",
      terminalEvent: { type: "turn.interrupted" },
    });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("does not queue interrupt behind the execution lock", async () => {
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

    const interruptResponse = await handler.handleInterruptRequest(
      new Request("https://brain.local/interrupt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runId,
          workspaceId: "123e4567-e89b-42d3-a456-426614174111",
          sessionId: "session-123456",
          threadId: "thr_123456",
          turnId: "trn_123456",
          runAttemptId: "attempt_123456",
        }),
      }),
    );

    expect(interruptResponse.status).toBe(409);
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

  it("delivers a lifecycle approval through the active runtime once and replays that event on retry", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);
    const runId = "run_123e4567e89b42d3a456426614174336";
    const turnId = "trn_123456";
    const approvalId = "appr_123456";
    await runRepo.create(
      new Run(runId, "session-1", "RUNNING", "coding", {
        agentType: "coding",
        prompt: "run tests",
        sessionId: "session-1",
      }),
    );
    await ctx.storage.put("turnToRunMap", { [turnId]: runId });
    const approvals = new PermissionApprovalStore(runtimeState, runId);
    await approvals.setPendingRequest({
      requestId: approvalId,
      runId,
      origin: "agent",
      category: "shell_command",
      title: "Run tests",
      reason: "Shell command can mutate state.",
      actionFingerprint: "shell:pnpm test",
      availableDecisions: ["allow_once", "deny", "abort"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const events: Array<Record<string, unknown>> = [];
    const lifecycleEventStore = {
      replay: vi.fn(async () => ({
        events,
        nextSequence: null,
      })),
    } as unknown as LifecycleEventStore;
    const approvalRegistry = new InMemoryRunApprovalResolutionRegistry();
    const resolve = vi.fn(async () => {
      events.push({
        type: "approval.decided",
        approvalId,
        payload: { status: "approved" },
      });
    });
    approvalRegistry.register(TurnIdSchema.parse(turnId), resolve);
    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      { lifecycleEventStore, approvalResolutionRegistry: approvalRegistry },
    );
    const submit = (decision: "approved" | "denied") =>
      handler.handleLifecycleApprovalRequest(
        new Request("https://brain.local/lifecycle-approval", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnId, approvalId, decision }),
        }),
      );

    const first = await submit("approved");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      type: "approval.decided",
      approvalId,
    });
    expect(resolve).toHaveBeenCalledTimes(1);

    const retry = await submit("approved");
    expect(retry.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);

    const conflict = await submit("denied");
    expect(conflict.status).toBe(409);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("fails closed without retaining a permission decision when the active approval resolver disappears", async () => {
    const ctx = new MockDurableObjectState();
    const runtimeState = tagRuntimeStateSemantics(ctx, "do");
    const runRepo = new RunRepository(runtimeState);
    const runId = "run_123e4567e89b42d3a456426614174337";
    const turnId = "trn_123457";
    const approvalId = "appr_123457";
    await runRepo.create(
      new Run(runId, "session-1", "RUNNING", "coding", {
        agentType: "coding",
        prompt: "run tests",
        sessionId: "session-1",
      }),
    );
    await ctx.storage.put("turnToRunMap", { [turnId]: runId });
    const approvals = new PermissionApprovalStore(runtimeState, runId);
    await approvals.setPendingRequest({
      requestId: approvalId,
      runId,
      origin: "agent",
      category: "shell_command",
      title: "Run tests",
      reason: "Shell command can mutate state.",
      actionFingerprint: "shell:pnpm test",
      availableDecisions: ["allow_once", "deny"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const disappearingRegistry: RunApprovalResolutionRegistry = {
      register() {},
      has: () => true,
      resolve: async () => false,
      unregister() {},
    };
    const handler = new RunEngineRequestHandler(
      ctx as unknown as DurableObjectState,
      {} as Env,
      runImmediately,
      undefined,
      {
        lifecycleEventStore: {
          replay: async () => ({ events: [], nextSequence: null }),
        } as unknown as LifecycleEventStore,
        approvalResolutionRegistry: disappearingRegistry,
      },
    );

    const response = await handler.handleLifecycleApprovalRequest(
      new Request("https://brain.local/lifecycle-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          turnId,
          approvalId,
          decision: "approved",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(approvals.getResolvedDecision(approvalId)).resolves.toBeNull();
    await expect(approvals.isActionAllowed("shell:pnpm test")).resolves.toBe(
      false,
    );
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

function interruptRequest(identity: {
  runId: string;
  workspaceId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
}): Request {
  return new Request("https://brain.local/interrupt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(identity),
  });
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
