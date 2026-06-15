import { describe, expect, it, vi } from "vitest";
import { RuntimeKernel } from "./RuntimeKernel.js";
import {
  createEventStore,
  createManifestRepository,
  createPorts,
  manifest,
  run,
  turn,
} from "./test-fixtures.js";

describe("runtime kernel integration", () => {
  it("connects workspace-core, worker protocol port, and event-store", async () => {
    const eventStore = createEventStore();
    const repository = await createManifestRepository();
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
      .mockResolvedValueOnce({ kind: "complete", output: "Inspected package" });
    const kernel = new RuntimeKernel({
      eventStore,
      workspaceManifests: repository,
      ...ports,
      producerId: "runtime-kernel-integration",
    });

    const result = await kernel.startTurn({ run, turn });

    expect(result.workspace).toEqual(manifest);
    expect(ports.worker.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.id,
        workspace: manifest,
      }),
    );
    const replay = await eventStore.replay({
      scope: { scopeType: "run", scopeId: run.id },
      afterCursor: null,
      limit: 20,
    });
    expect(replay.events.at(0)?.producer).toEqual({
      kind: "runtime_kernel",
      id: "runtime-kernel-integration",
    });
    expect(replay.events.at(-1)?.type).toBe("turn.completed");
  });
});
