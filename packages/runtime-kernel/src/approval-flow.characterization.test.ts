import { ApprovalCoordinator } from "./ApprovalCoordinator.js";
import { RuntimeLifecycleCoordinator } from "./RuntimeLifecycleCoordinator.js";
import type { ApprovalResolution } from "./types.js";
import { ItemIdSchema, ToolCallIdSchema } from "@repo/platform-protocol";
import { describe, expect, it, vi } from "vitest";
import { RuntimeKernel } from "./RuntimeKernel.js";
import {
  approvalRequest,
  createArtifactPorts,
  createLifecycleSink,
  createManifestRepository,
  createPorts,
  finalItemId,
  run,
  runAttemptId,
  turn,
} from "./test-fixtures.js";

describe("approval continuation characterization", () => {
  it("records request and decision before retrying the exact worker call", async () => {
    const lifecycleEvents = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "tool_call",
        itemId: "itm_runtime001",
        content: {
          toolCallId: "toolcall_runtime001",
          toolName: "write_file",
          input: { path: "src/index.ts", content: "export {};" },
        },
      })
      .mockResolvedValueOnce({
        kind: "complete",
        itemId: finalItemId,
        output: "Done",
      });
    ports.worker.executeTool = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "approval_required",
        request: approvalRequest,
      })
      .mockResolvedValueOnce({ kind: "completed", output: { written: true } });
    const kernel = new RuntimeKernel({
      lifecycleEvents,
      ...createArtifactPorts(),
      workspaceManifests: await createManifestRepository(),
      ...ports,
      producerId: "runtime-kernel-test",
    });

    await kernel.startTurn({ run, turn, runAttemptId });

    expect(ports.worker.executeTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runAttemptId,
        approval: expect.objectContaining({ decision: "approved" }),
      }),
    );
    const types = lifecycleEvents.events.map((event) => event.type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.decided");
    expect(
      types.filter((type) => type === "turn.blocking_changed"),
    ).toHaveLength(2);
    expect(lifecycleEvents.events.at(-1)?.type).toBe("turn.completed");

    // Exercise the same canonical owner when the external provider waiter races
    // a committed user decision. No second source may authorize the tool.
    const racingSink = createLifecycleSink();
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => { releaseDecision = resolve; });
    let decisionAppending = false;
    const appendBatch = racingSink.appendBatch.bind(racingSink);
    racingSink.appendBatch = async (events) => {
      if (events.some((event) => event.type === "approval.decided")) {
        decisionAppending = true;
        await decisionGate;
      }
      return appendBatch(events);
    };
    const lifecycle = new RuntimeLifecycleCoordinator({
      sink: racingSink, producerId: "approval-race", clock: { now: () => "2026-11-06T12:00:00Z" },
      threadId: run.threadId, workspaceId: run.workspaceId, turnId: turn.id, runAttemptId,
    });
    await lifecycle.start();
    const toolItem = ItemIdSchema.parse("itm_racingtool001");
    await lifecycle.startToolCall(toolItem, ToolCallIdSchema.parse("toolcall_racing001"), "write_file", {});
    let approveFromWaiter!: (resolution: ApprovalResolution) => void;
    const waiter = vi.fn(() => new Promise<ApprovalResolution>((resolve) => { approveFromWaiter = resolve; }));
    const coordinator = new ApprovalCoordinator({ waitForDecision: waiter }, lifecycle);
    const waiting = coordinator.requestAndWait(run, runAttemptId, turn, toolItem, approvalRequest);
    const rejectedWaiter = expect(waiting).rejects.toMatchObject({ code: "approval_denied" });
    await vi.waitFor(() => expect(waiter).toHaveBeenCalledOnce());
    const denying = coordinator.resolve(approvalRequest.approvalId, {
      decision: "denied", decidedBy: run.userId, reason: "Denied by owner",
    });
    await vi.waitFor(() => expect(decisionAppending).toBe(true));
    approveFromWaiter({ decision: "approved", decidedBy: run.userId, reason: null });
    await expect(coordinator.resolve(approvalRequest.approvalId, {
      decision: "approved", decidedBy: run.userId, reason: null,
    })).rejects.toMatchObject({ code: "approval_resolution_conflict" });
    releaseDecision();
    await denying;
    await rejectedWaiter;
    expect(racingSink.events.filter((event) => event.type === "approval.decided")
      .map((event) => event.payload.status)).toEqual(["denied"]);
  });
});
