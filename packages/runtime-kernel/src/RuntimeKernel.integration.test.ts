import { HarnessSelectionSchema, LeaseIdSchema } from "@repo/platform-protocol";
import type { HarnessCommitAck, HarnessObservation, HarnessSession } from "@repo/worker-protocol";
import type { HarnessObservationCommitPort, DelegatedHarnessPort } from "./harness/DelegatedHarnessPort.js";
import { describe, expect, it, vi } from "vitest";
import { RuntimeKernel } from "./RuntimeKernel.js";
import {
  approvalRequest,
  timestamp,
  createLifecycleSink,
  createArtifactPorts,
  createManifestRepository,
  createPorts,
  finalItemId,
  manifest,
  run,
  runAttemptId,
  turn,
} from "./test-fixtures.js";

describe("runtime kernel integration", () => {
  it("connects canonical lifecycle, workspace, and worker boundaries", async () => {
    const lifecycleEvents = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "tool_call",
        itemId: "itm_runtime001",
        content: {
          toolCallId: "toolcall_runtime001",
          toolName: "read_file",
          input: { path: "package.json" },
        },
      })
      .mockResolvedValueOnce({
        kind: "complete",
        itemId: finalItemId,
        output: "Inspected package",
      });
    const kernel = new RuntimeKernel({
      lifecycleEvents,
      ...createArtifactPorts(),
      workspaceManifests: await createManifestRepository(),
      ...ports,
      producerId: "runtime-kernel-integration",
    });

    const result = await kernel.startTurn({ run, turn, runAttemptId });

    expect(result.workspace).toEqual(manifest);
    expect(ports.worker.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ runAttemptId, workspace: manifest }),
    );
    expect(lifecycleEvents.events.at(0)?.producer).toEqual({
      kind: "runtime_kernel",
      id: "runtime-kernel-integration",
    });
    expect(lifecycleEvents.events.at(-1)?.type).toBe("turn.completed");
    expect(
      lifecycleEvents.events.filter((event) => event.type === "turn.completed"),
    ).toHaveLength(1);

    const delegatedSink = createLifecycleSink();
    const selection = HarnessSelectionSchema.parse({
      userId: run.userId, workspaceId: run.workspaceId, environmentId: "cloud-test", selectionRevision: 0, workspaceGrantId: "grant-test",
      threadId: run.threadId, runId: run.id, turnId: turn.id, runAttemptId,
      harness: "codex", instanceId: "instance-test", connectionId: "connection-test", authOwnerGeneration: 7,
      modelId: run.modelId, policyId: run.permissionProfileId, policyRevision: "policy-1",
      billingSource: "api_key", runtimeVersion: "0.167.0", protocolVersion: "0.167.0-schema",
      transport: "codex_app_server_stdio",
    });
    const session: HarnessSession = { runAttemptId, instanceId: selection.instanceId, externalSessionId: "external-session", processGeneration: "00000000-0000-4000-8000-000000000003" };
    const ledger = new Map<string, { fingerprint: string; ack: HarnessCommitAck }>();
    let recoveryEvents = delegatedSink.events;
    const persistence: HarnessObservationCommitPort = {
      async recover(activeSession) { return { session: activeSession, lifecycleEvents: recoveryEvents,
        lastSequence: 0, externalTurnId: null, terminal: null, quiescence: null, pendingRequests: [] }; },
      async claimReply() { return "claimed"; },
      async lookup(observation) {
        const entry = ledger.get(JSON.stringify([observation.session, observation.sequence]));
        if (entry && entry.fingerprint !== JSON.stringify(observation)) throw new Error("ingress fingerprint conflict");
        return entry?.ack ?? null;
      },
      async commit({ observation, events }) {
        const prior = await this.lookup(observation);
        if (prior) return prior;
        await delegatedSink.appendBatch(events);
        const ack = { session: observation.session, committedSequence: observation.sequence };
        ledger.set(JSON.stringify([observation.session, observation.sequence]), { fingerprint: JSON.stringify(observation), ack });
        return ack;
      },
    };
    let releaseApproval!: () => void;
    const replyReceived = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const harness: DelegatedHarnessPort = {
      observeExisting: vi.fn(async () => undefined),
      open: vi.fn(async () => session),
      execute: vi.fn(async ({ observe }) => {
        const fact = (sequence: number, payload: HarnessObservation["payload"]): HarnessObservation => ({ session, sequence, externalTurnId: "external-turn", payload });
        const started = fact(1, { kind: "tool_started", itemId: finalItemId,
          content: { toolCallId: "toolcall_runtime001" as import("@repo/platform-protocol").ToolCallId, toolName: "write_file", input: {} } });
        await observe(started);
        await observe(started);
        await expect(observe({ ...started, session: { ...session, processGeneration: "00000000-0000-4000-8000-000000000002" } })).rejects.toMatchObject({ code: "worker_failed" });
        await expect(observe({ ...started, payload: { kind: "usage", usage: {} } } as unknown as HarnessObservation)).rejects.toBeDefined();
        await observe(fact(2, { kind: "approval_requested", parentItemId: finalItemId, request: approvalRequest,
          replyTo: { session, origin: "codex-reverse-rpc", requestId: "native-request-1", authOwnerGeneration: 7 } }));
        await replyReceived;
        await observe(fact(3, { kind: "tool_completed", itemId: finalItemId, output: "Written" }));
        const terminal = fact(4, { kind: "external_terminal", status: "completed", providerCompletedAt: timestamp, itemId: "itm_delegatedfinal" as typeof finalItemId, output: "Delegated done", error: null });
        await observe(terminal);
        await observe(terminal);
      }),
      control: vi.fn(async (command) => { if (command.kind === "reply") releaseApproval(); return { accepted: true }; }),
      awaitQuiescence: vi.fn(async () => ({ status: "quiescent" as const, session, observedAt: timestamp, evidenceId: "tree-proof", scope: "process_tree_and_background_work" as const })),
    };
    const delegatedPorts = createPorts();
    const delegatedKernel = new RuntimeKernel({ lifecycleEvents: delegatedSink,
      ...createArtifactPorts(), workspaceManifests: await createManifestRepository(), ...delegatedPorts,
      producerId: "delegated-integration", delegated: { harness, observations: persistence, assertActive: vi.fn(async () => undefined) } });
    const delegatedResult = await delegatedKernel.startTurn({ run, turn, runAttemptId,
      execution: { kind: "delegated", selection, leaseId: LeaseIdSchema.parse("lease_runtime001"), prompt: "Edit the file", resumeSession: null } });
    expect(delegatedResult.output).toBe("Delegated done");
    expect(delegatedPorts.provider.generateNext).not.toHaveBeenCalled();
    expect(delegatedPorts.contextAssembly.assemble).not.toHaveBeenCalled();
    expect(delegatedPorts.worker.executeTool).not.toHaveBeenCalled();
    expect(harness.control).toHaveBeenCalledOnce();
    expect(delegatedSink.events.filter((event) => event.type === "approval.requested")).toHaveLength(1);
    expect(delegatedSink.events.filter((event) => event.type === "tool_call.started")).toHaveLength(1);
    expect(delegatedSink.events.at(-1)?.type).toBe("turn.completed");

    // Stop during open must latch before prompt dispatch, even if opening finishes later.
    let finishOpen!: (value: HarnessSession) => void;
    const stoppedHarness = { ...harness, open: vi.fn(() => new Promise<HarnessSession>((resolve) => { finishOpen = resolve; })),
      execute: vi.fn(async () => undefined), control: vi.fn(async () => ({ accepted: true })) };
    const stopSink = createLifecycleSink();
    recoveryEvents = stopSink.events;
    const stopKernel = new RuntimeKernel({ lifecycleEvents: stopSink, ...createArtifactPorts(),
      workspaceManifests: await createManifestRepository(), ...createPorts(), producerId: "stop-race",
      delegated: { harness: stoppedHarness, observations: persistence, assertActive: async () => undefined } });
    const starting = stopKernel.startTurn({ run, turn, runAttemptId,
      execution: { kind: "delegated", selection, leaseId: LeaseIdSchema.parse("lease_runtime001"), prompt: "Must not dispatch", resumeSession: null } });
    const stopped = expect(starting).rejects.toMatchObject({ code: "turn_cancelled" });
    await vi.waitFor(() => expect(stoppedHarness.open).toHaveBeenCalledOnce());
    const stopping = stopKernel.interruptTurn(turn.id, "Stop during open");
    finishOpen(session);
    await stopping;
    await stopped;
    expect(stoppedHarness.execute).not.toHaveBeenCalled();
    expect(stopSink.events.at(-1)?.type).toBe("turn.interrupted");
  });
});
