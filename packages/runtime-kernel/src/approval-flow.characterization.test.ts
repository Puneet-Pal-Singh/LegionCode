import { describe, expect, it, vi } from "vitest";
import { RuntimeKernel } from "./RuntimeKernel.js";
import {
  approvalRequest,
  createEventStore,
  createManifestRepository,
  createPorts,
  run,
  turn,
} from "./test-fixtures.js";

describe("approval continuation characterization", () => {
  it("records request and decision before retrying the exact worker call", async () => {
    const eventStore = createEventStore();
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
      .mockResolvedValueOnce({ kind: "complete", output: "Done" });
    ports.worker.executeTool = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "approval_required",
        request: approvalRequest,
      })
      .mockResolvedValueOnce({ kind: "completed", output: { written: true } });
    const kernel = new RuntimeKernel({
      eventStore,
      workspaceManifests: await createManifestRepository(),
      ...ports,
      producerId: "runtime-kernel-test",
    });

    await expect(kernel.startTurn({ run, turn })).resolves.toMatchObject({
      status: "completed",
      toolCallCount: 1,
    });
    expect(ports.worker.executeTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ approval: null }),
    );
    expect(ports.worker.executeTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        approval: expect.objectContaining({ decision: "approved" }),
      }),
    );
    const replay = await eventStore.replay({
      scope: { scopeType: "run", scopeId: run.id },
      afterCursor: null,
      limit: 20,
    });
    expect(replay.events.map((event) => event.type)).toEqual([
      "turn.started",
      "tool.call.requested",
      "tool.call.started",
      "approval.requested",
      "approval.decided",
      "tool.call.completed",
      "turn.completed",
    ]);
  });
});
