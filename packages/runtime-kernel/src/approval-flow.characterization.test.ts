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
  });
});
