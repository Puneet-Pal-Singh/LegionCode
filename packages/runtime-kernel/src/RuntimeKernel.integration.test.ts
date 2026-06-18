import { describe, expect, it, vi } from "vitest";
import { RuntimeKernel } from "./RuntimeKernel.js";
import {
  createLifecycleSink,
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
  });
});
