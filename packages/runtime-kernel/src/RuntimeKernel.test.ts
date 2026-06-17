import { describe, expect, it, vi } from "vitest";
import {
  ArtifactIdSchema,
  ItemIdSchema,
  RunIdSchema,
  ToolCallIdSchema,
} from "@repo/platform-protocol";
import { RuntimeKernel } from "./RuntimeKernel.js";
import {
  createEventStore,
  createManifestRepository,
  createPorts,
  manifest,
  run,
  timestamp,
  turn,
} from "./test-fixtures.js";

describe("RuntimeKernel package behavior", () => {
  it("starts and completes a provider-only turn", async () => {
    const ports = createPorts();
    const kernel = new RuntimeKernel({
      eventStore: createEventStore(),
      workspaceManifests: await createManifestRepository(),
      ...ports,
      producerId: "runtime-kernel-test",
      clock: { now: () => timestamp },
    });

    await expect(kernel.startTurn({ run, turn })).resolves.toEqual({
      status: "completed",
      output: "Done",
      toolCallCount: 0,
      workspace: manifest,
    });
    expect(ports.contextAssembly.assemble).toHaveBeenCalledWith({
      run,
      turn: expect.objectContaining({ status: "running" }),
      workspace: manifest,
    });
  });

  it("fails before provider execution when durable workspace truth is absent", async () => {
    const ports = createPorts();
    const eventStore = createEventStore();
    const repository = await createManifestRepository();
    vi.spyOn(repository, "getLatestByRunId").mockResolvedValue(null);
    const kernel = new RuntimeKernel({
      eventStore,
      workspaceManifests: repository,
      ...ports,
      producerId: "runtime-kernel-test",
    });

    await expect(kernel.startTurn({ run, turn })).rejects.toMatchObject({
      code: "workspace_not_found",
    });
    expect(ports.provider.generateNext).not.toHaveBeenCalled();
    const replay = await eventStore.replay({
      scope: { scopeType: "run", scopeId: run.id },
      afterCursor: null,
      limit: 10,
    });
    expect(replay.events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.failed",
    ]);
  });

  it("rejects a turn that does not belong to the run", async () => {
    const ports = createPorts();
    const kernel = new RuntimeKernel({
      eventStore: createEventStore(),
      workspaceManifests: await createManifestRepository(),
      ...ports,
      producerId: "runtime-kernel-test",
    });

    await expect(
      kernel.startTurn({
        run,
        turn: { ...turn, runId: RunIdSchema.parse("run_other001") },
      }),
    ).rejects.toMatchObject({ code: "invalid_turn_identity" });
  });

  it("records worker failure before failing the turn", async () => {
    const eventStore = createEventStore();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => ({
      kind: "tool_call" as const,
      itemId: ItemIdSchema.parse("itm_runtime001"),
      content: {
        toolCallId: ToolCallIdSchema.parse("toolcall_runtime001"),
        toolName: "write_file",
        input: { path: "src/index.ts" },
      },
    }));
    ports.worker.executeTool = vi.fn(async () => ({
      kind: "failed" as const,
      failure: {
        code: "command_failed" as const,
        message: "Write failed",
        retryable: false,
        correlationId: null,
        details: null,
      },
    }));
    const kernel = new RuntimeKernel({
      eventStore,
      workspaceManifests: await createManifestRepository(),
      ...ports,
      producerId: "runtime-kernel-test",
    });

    await expect(kernel.startTurn({ run, turn })).rejects.toMatchObject({
      code: "worker_failed",
    });
    const replay = await eventStore.replay({
      scope: { scopeType: "run", scopeId: run.id },
      afterCursor: null,
      limit: 10,
    });
    expect(replay.events.map((event) => event.type)).toEqual([
      "turn.started",
      "tool.call.requested",
      "tool.call.started",
      "tool.call.failed",
      "turn.failed",
    ]);
    const failure = replay.events.find(
      (event) => event.type === "tool.call.failed",
    );
    expect(failure?.payload).toMatchObject({
      failure: {
        code: "command_failed",
        message: "Write failed",
        details: { runtimeKernelCode: "worker_failed" },
      },
    });
  });

  it("maps worker command output before completing the tool call", async () => {
    const eventStore = createEventStore();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "tool_call" as const,
        itemId: ItemIdSchema.parse("itm_runtime001"),
        content: {
          toolCallId: ToolCallIdSchema.parse("toolcall_runtime001"),
          toolName: "run_command",
          input: { argv: ["pnpm", "test"] },
        },
      })
      .mockResolvedValueOnce({ kind: "complete" as const, output: "Done" });
    ports.worker.executeTool = vi.fn(async () => ({
      kind: "completed" as const,
      output: {
        exitCode: 0,
        stdout: "tests passed",
        stderr: "",
        durationMs: 10,
        timedOut: false,
        signal: null,
      },
    }));
    const kernel = new RuntimeKernel({
      eventStore,
      workspaceManifests: await createManifestRepository(),
      ...ports,
      producerId: "runtime-kernel-test",
    });

    await expect(kernel.startTurn({ run, turn })).resolves.toMatchObject({
      status: "completed",
    });
    const replay = await eventStore.replay({
      scope: { scopeType: "run", scopeId: run.id },
      afterCursor: null,
      limit: 20,
    });
    expect(replay.events.map((event) => event.type)).toEqual([
      "turn.started",
      "tool.call.requested",
      "tool.call.started",
      "tool.call.output.delta",
      "tool.call.completed",
      "turn.completed",
    ]);
    expect(replay.events[3]?.payload).toMatchObject({
      itemId: "itm_runtime001",
      toolCallId: "toolcall_runtime001",
      delta: "tests passed",
    });
  });

  it("emits artifact-created events separately from tool output", async () => {
    const eventStore = createEventStore();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "tool_call" as const,
        itemId: ItemIdSchema.parse("itm_runtime001"),
        content: {
          toolCallId: ToolCallIdSchema.parse("toolcall_runtime001"),
          toolName: "artifact_upload",
          input: { path: "logs/command.log" },
        },
      })
      .mockResolvedValueOnce({ kind: "complete" as const, output: "Done" });
    ports.worker.executeTool = vi.fn(async () => ({
      kind: "completed" as const,
      output: {
        artifactId: "art_runtime001",
        kind: "command_log",
        ownership: {
          createdBy: run.userId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          runId: run.id,
        },
        visibility: "run",
        payload: {
          backend: "memory",
          storageKey: "artifacts/run_runtime001/command.log",
          contentType: "text/plain",
          byteSize: 12,
          sha256: "a".repeat(64),
        },
        properties: { label: "Command log" },
        createdAt: timestamp,
      },
    }));
    const kernel = new RuntimeKernel({
      eventStore,
      workspaceManifests: await createManifestRepository(),
      ...ports,
      producerId: "runtime-kernel-test",
    });

    await expect(kernel.startTurn({ run, turn })).resolves.toMatchObject({
      status: "completed",
    });
    const artifactReplay = await eventStore.replay({
      scope: {
        scopeType: "artifact",
        scopeId: ArtifactIdSchema.parse("art_runtime001"),
      },
      afterCursor: null,
      limit: 10,
    });
    expect(artifactReplay.events.map((event) => event.type)).toEqual([
      "artifact.created",
    ]);
    expect(artifactReplay.events[0]?.payload).toMatchObject({
      itemId: "itm_runtime001",
      artifact: {
        artifactId: "art_runtime001",
        payloadRef: {
          objectKey: "artifacts/run_runtime001/command.log",
          sha256: "a".repeat(64),
        },
      },
    });
  });
});
