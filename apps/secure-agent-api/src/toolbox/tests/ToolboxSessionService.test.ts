import { describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { CloudflareToolboxAdapter } from "../adapters/CloudflareToolboxAdapter";
import type {
  ToolboxCommandExecutionOptions,
  ToolboxCommandExecutor,
} from "../contracts/ToolboxSession";
import type { ToolboxEvent } from "../events/ToolboxEventFactory";
import type { ToolboxEventPublisher } from "../events/ToolboxEventPublisher";
import { ToolboxSessionService } from "../services/ToolboxSessionService";
import { OwnedNativeCommandSession, hasUnsettledNativeCommand, type NativeSessionFields } from "../../core/OwnedNativeCommandSession";
import type { ArtifactStorePort } from "../../ports/ArtifactStorePort";
import type { SandboxExecutionLease } from "../../ports/SandboxExecutionLease";
import { executionDomainDigest, snapshotExecutionDomain } from "@repo/worker-protocol/private/execution-domain";
import { NativeCommandReceiptSchema, type NativeCommandOriginal, type NativeCommandRequest, type OwnedNativeSandboxPort } from "../contracts/OwnedSandboxCommand";

interface ExecutorMock extends ToolboxCommandExecutor {
  execCalls: string[];
  optionsCalls: Array<ToolboxCommandExecutionOptions | undefined>;
}

function createExecutorMock(
  execImpl?: (
    command: string,
    options?: ToolboxCommandExecutionOptions,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): ExecutorMock {
  const execCalls: string[] = [];
  const optionsCalls: Array<ToolboxCommandExecutionOptions | undefined> = [];
  return {
    execCalls,
    optionsCalls,
    execute: execImpl
      ? async (command, options) => {
          execCalls.push(command);
          optionsCalls.push(options);
          return execImpl(command, options);
        }
      : async (command, options) => {
          execCalls.push(command);
          optionsCalls.push(options);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
  };
}

function createEventPublisherMock(): {
  events: ToolboxEvent[];
  publisher: ToolboxEventPublisher;
} {
  const events: ToolboxEvent[] = [];
  return {
    events,
    publisher: {
      publish(event) {
        events.push(event);
      },
    },
  };
}

describe("ToolboxSessionService", () => {
  it("creates a unique toolbox session per execution", async () => {
    const executor = createExecutorMock();
    const service = new ToolboxSessionService(executor);

    const first = await service.execute(
      {
        runId: "run-1",
        toolName: "node.run",
        callId: "call-1",
        command: "node",
      },
      ["node"],
    );
    const second = await service.execute(
      {
        runId: "run-1",
        toolName: "node.run",
        callId: "call-2",
        command: "node",
      },
      ["node"],
    );

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(executor.execCalls).toHaveLength(2);
  });

  it("creates unique session ids even when callId and toolName repeat", async () => {
    const executor = createExecutorMock();
    const service = new ToolboxSessionService(executor);

    const first = await service.execute(
      {
        runId: "run-repeat",
        toolName: "git.status",
        callId: "task-123",
        command: "git",
      },
      ["git"],
    );
    const second = await service.execute(
      {
        runId: "run-repeat",
        toolName: "git.status",
        callId: "task-123",
        command: "git",
      },
      ["git"],
    );

    expect(first.callId).toBe("task-123");
    expect(second.callId).toBe("task-123");
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("publishes requested and lifecycle status events with stable correlation", async () => {
    const executor = createExecutorMock();
    const eventPublisher = createEventPublisherMock();
    const service = new ToolboxSessionService(
      executor,
      eventPublisher.publisher,
    );

    const result = await service.execute(
      {
        runId: "run-events",
        toolName: "node.run",
        callId: "task-456",
        command: "node",
      },
      ["node"],
    );

    expect(result.status).toBe("completed");
    expect(eventPublisher.events).toHaveLength(3);
    expect(eventPublisher.events.map((event) => event.status)).toEqual([
      "requested",
      "started",
      "completed",
    ]);

    for (const event of eventPublisher.events) {
      expect(event.sessionId).toBe(result.sessionId);
      expect(event.runId).toBe("run-events");
      expect(event.toolName).toBe("node.run");
      expect(event.callId).toBe("task-456");
    }

    for (const message of ["HTTP error! status: 500", "createSession response lost"]) {
      const exec = vi.fn(async () => { throw new Error(message); });
      const execIfRunning = vi.fn(async () => ({ exitCode: 0, stdout: "borrowed", stderr: "" }));
      const adapter = new CloudflareToolboxAdapter({ exec, execIfRunning } as unknown as Sandbox);
      const failedEvents = createEventPublisherMock();
      const hosted = new ToolboxSessionService(adapter, failedEvents.publisher);
      const options = { cwd: "/home/sandbox/checkouts/checkout-1", env: { NODE_ENV: "test" } };
      const failed = await hosted.execute({
        runId: "run-ambiguous", toolName: "node.run", callId: "call-ambiguous",
        command: "npm", args: ["run", "test"], ...options,
      }, ["npm"]);
      expect(failed.status).toBe("failed");
      expect(failed.stderr).toBe(message);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith("'npm' 'run' 'test'", options);
      expect(execIfRunning).not.toHaveBeenCalled();
      expect(failedEvents.events.map((event) => event.status)).toEqual(["requested", "started", "failed"]);
      for (const event of failedEvents.events) expect(event.sessionId).toBe(failed.sessionId);

      await expect(adapter.execute("git status", { ...options, borrowedLease: true }))
        .resolves.toEqual({ exitCode: 0, stdout: "borrowed", stderr: "" });
      expect(execIfRunning).toHaveBeenCalledTimes(1);
      expect(execIfRunning).toHaveBeenCalledWith("git status", options);
      expect(exec).toHaveBeenCalledTimes(1);
    }
    await assertNativeOriginalOwnership();
  });

  it("returns a failed result when policy denies the command", async () => {
    const executor = createExecutorMock();
    const service = new ToolboxSessionService(executor);

    const result = await service.execute(
      {
        runId: "run-2",
        toolName: "node.run",
        callId: "call-denied",
        command: "bash",
      },
      ["node"],
    );

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("Command not allowed");
    expect(executor.execCalls).toHaveLength(0);
  });

  it("marks slow executions as timed out", async () => {
    const executor = createExecutorMock(
      async () =>
        await new Promise((resolve) => {
          setTimeout(() => {
            resolve({ exitCode: 0, stdout: "late", stderr: "" });
          }, 25);
        }),
    );
    const service = new ToolboxSessionService(executor);

    const result = await service.execute(
      {
        runId: "run-3",
        toolName: "node.run",
        callId: "call-timeout",
        command: "node",
        timeoutMs: 5,
      },
      ["node"],
    );

    expect(result.status).toBe("timeout");
    expect(result.exitCode).toBe(124);
  });
});

async function assertNativeOriginalOwnership() {
  const executionDomain = snapshotExecutionDomain({
    version: 1, domain: "legioncode_native",
    scope: { userId: "user-1", brainSessionId: "brain-session-1", workspaceId: "workspace-1",
      runId: "run-1", threadId: "thread-1", turnId: "turn-1", runAttemptId: "attempt-1" },
  });
  const lease: SandboxExecutionLease = {
    executionDomainDigest: await executionDomainDigest(executionDomain),
    leaseId: "lease-1", sandboxId: "sandbox-1", generation: 0, owner: "session-1",
    correlationId: "correlation-1", expiresAt: Date.now() + 60_000, mutationMode: "serialized",
    workspaceScope: { root: "/home/sandbox/checkouts/fixture", workspaceId: "workspace-1", runId: "run-1", threadId: "thread-1", turnId: "turn-1", runAttemptId: "attempt-1" },
  };
  const root = { device: "1", inode: "9007199254740993" };
  const metadata = { identity: "linux-git-metadata-v1:"+"d".repeat(64),
    paths: { version: 1 as const, workspaceRoot: lease.workspaceScope.root, gitEntry: `${lease.workspaceScope.root}/.git`, gitDirectory: `${lease.workspaceScope.root}/.git`, commonDirectory: `${lease.workspaceScope.root}/.git`, backlinkPath: null, backlinkRecordPath: null },
    entries: [{ path: `${lease.workspaceScope.root}/.git`, device: "1", inode: "3", kind: "directory" as const }] };
  const records = new Map<string, unknown>([["execution:session:session-1", { lease, executionDomain, workspaceScope: lease.workspaceScope, nativeWorkspace: { root, metadata, sandboxBootId: "123e4567-e89b-42d3-a456-426614174000" } }]]);
  const state = {
    blockConcurrencyWhile: async <T>(operation: () => Promise<T>) => await operation(),
    storage: {
      get: async <T>(key: string) => structuredClone(records.get(key)) as T,
      put: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
      list: async ({ prefix }: { prefix: string }) => new Map([...records].filter(([key]) => key.startsWith(prefix))),
    },
  } as unknown as DurableObjectState;
  const read = () => records.get("execution:session:session-1") as NativeSessionFields;
  let request: NativeCommandRequest;
  let finish!: (value: NativeCommandOriginal) => void;
  const original = new Promise<NativeCommandOriginal>(resolve => { finish = resolve; });
  let acknowledged!: () => void;
  const ack = new Promise<void>(resolve => { acknowledged = resolve; });
  let phase = "prepared", launches = 0, starts = 0;
  const receipt = () => NativeCommandReceiptSchema.parse({
    version: 1, binding: request.binding, state: phase,
    identity: { bootId: "123e4567-e89b-42d3-a456-426614174000", namespaceDevice: "4", namespaceInode: "5", initHostPid: 6,
      root, cgroup: { device: "7", inode: "8" }, limits: request.limits, metadataIdentity: metadata.identity },
    gateClosed: phase === "closed", admission: phase === "closed", outputLimited: false,
    ...(phase === "closed" ? { exitCode: 0, stdout: btoa("native output") } : {}),
  });
  const sandbox: OwnedNativeSandboxPort = {
    executeNativeCommand: async input => {
      launches++; request = input;
      expect(read().nativeCommand?.phase).toBe("dispatching");
      expect(read().nativeCommand?.binding).toEqual(input.binding);
      return await original;
    },
    controlNativeCommand: async input => {
      expect(input.binding).toEqual(request.binding);
      if (input.action === "start") {
        starts++;
        expect(read().nativeCommand?.phase).toBe("gate_dispatching");
        expect(read().nativeCommand?.identity).toEqual(receipt().identity);
        phase = "closed";
      }
      if (input.action === "ack") {
        expect(read().nativeCommand?.phase).toBe("scope_closed");
        expect(read().nativeCommand?.receiptArtifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
        acknowledged();
      }
      return receipt();
    },
    prepareNativeWorkspace: async () => { throw new Error("Not a provisioning fixture"); },
  };
  let artifact: Uint8Array | undefined;
  const artifacts = {
    upload: async ({ data }: { data: Uint8Array }) => {
      artifact = data;
      expect(new TextDecoder().decode(data)).not.toContain(read().nativeCommand!.controlToken);
      return { id: "artifacts/session-1/receipt.json" };
    },
    download: async () => artifact,
  } as unknown as ArtifactStorePort;
  const owner = new OwnedNativeCommandSession({ state, sessionId: "session-1", lease, taskId: "task-1", sandbox, artifacts });
  const execution = owner.execute({ argv: ["npm", "test"] });
  await ack;
  expect(await owner.awaitClosure()).toBe(false);
  expect(hasUnsettledNativeCommand(read())).toBe(true);
  expect(read().nativeCommand?.originalTransportSettled).toBeUndefined();
  await expect(owner.execute({ argv: ["npm", "test"] })).rejects.toThrow("CLOSURE_UNAVAILABLE");
  expect(launches).toBe(1);
  expect(starts).toBe(1);
  finish({ stdout: JSON.stringify(receipt()), stderr: "", exitCode: 0 });
  await expect(execution).resolves.toEqual({ exitCode: 0, stdout: "native output", stderr: "" });
  await owner.drainOriginalOperations();
  expect(await owner.awaitClosure()).toBe(true);
  expect(hasUnsettledNativeCommand(read())).toBe(false);
  expect(read().nativeCommand?.originalTransportSettled).toBe(true);
  const evidence = await owner.closureEvidence();
  expect(evidence?.state).toBe("settled");
  if (evidence?.state !== "settled") throw new Error("Expected exact native closure");
  expect(evidence.root.inode).toBe("9007199254740993");
  expect(evidence.scope).toMatchObject({ sessionId: "session-1", taskId: "task-1", generation: 0, runAttemptId: "attempt-1" });
  expect(JSON.stringify(evidence)).not.toContain(read().nativeCommand!.controlToken);

  const settledSession = records.get("execution:session:session-1") as NativeSessionFields;
  settledSession.nativeCommand!.binding.generation = 1;
  const corruptReplay = new OwnedNativeCommandSession({ state, sessionId: "session-1", lease, taskId: "task-1", sandbox, artifacts });
  expect(hasUnsettledNativeCommand(settledSession)).toBe(true);
  expect((await corruptReplay.closureEvidence())?.state).toBe("unknown");
  settledSession.nativeCommand!.binding.generation = 0;

  // A reconstructed session cannot recreate a lost original transport handle.
  const saved = records.get("execution:session:session-1") as NativeSessionFields;
  saved.nativeCommand!.phase = "unknown";
  delete saved.nativeCommand!.originalTransportSettled;
  const restored = new OwnedNativeCommandSession({ state, sessionId: "session-1", lease, taskId: "task-1", sandbox, artifacts });
  expect(await restored.awaitClosure()).toBe(false);
  await expect(restored.execute({ argv: ["npm", "test"] })).rejects.toThrow("CLOSURE_UNAVAILABLE");
  expect(launches).toBe(1);
}
