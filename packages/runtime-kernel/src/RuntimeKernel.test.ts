import {
  ItemIdSchema,
  LifecycleTransitionError,
  ToolCallIdSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeKernelError,
  RuntimeLifecycleSettlementError,
} from "./errors.js";
import type { LifecycleEventSink } from "./ports.js";
import { RuntimeKernel } from "./RuntimeKernel.js";
import {
  MemoryLifecycleEventSink,
  createLifecycleSink,
  createManifestRepository,
  createPorts,
  finalItemId,
  manifest,
  run,
  runAttemptId,
  timestamp,
  turn,
} from "./test-fixtures.js";

describe("RuntimeKernel canonical lifecycle", () => {
  it("settles a provider-only turn exactly once with the terminal event last", async () => {
    const sink = createLifecycleSink();
    const kernel = await createKernel(sink);

    await expect(kernel.startTurn({ run, turn, runAttemptId })).resolves.toEqual({
      status: "completed",
      output: "Done",
      toolCallCount: 0,
      workspace: manifest,
    });

    expect(eventTypes(sink)).toEqual([
      "turn.queued",
      "turn.started",
      "run_attempt.started",
      "item.started",
      "assistant_message.delta",
      "item.completed",
      "run_attempt.succeeded",
      "turn.completed",
    ]);
    expect(terminalEvents(sink)).toHaveLength(1);
  });

  it("settles failed tool work before the explicit failed turn outcome", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => toolStep());
    ports.worker.executeTool = vi.fn(async () => ({
      kind: "failed" as const,
      failure: protocolFailure("Write failed"),
    }));
    const kernel = await createKernel(sink, ports);

    await expect(kernel.startTurn({ run, turn, runAttemptId })).rejects.toMatchObject({
      code: "worker_failed",
    });

    expect(eventTypes(sink).slice(-4)).toEqual([
      "tool_call.failed",
      "item.failed",
      "run_attempt.failed",
      "turn.failed",
    ]);
    expect(terminalEvents(sink)).toHaveLength(1);
  });

  it("emits canonical tool output and settles its item before completion", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce(toolStep())
      .mockResolvedValueOnce({ kind: "complete", itemId: finalItemId, output: "Done" });
    ports.worker.executeTool = vi.fn(async () => ({
      kind: "completed" as const,
      output: { stdout: "tests passed" },
    }));
    const kernel = await createKernel(sink, ports);

    await kernel.startTurn({ run, turn, runAttemptId });

    expect(eventTypes(sink)).toContain("tool_call.output_delta");
    expect(eventTypes(sink).indexOf("item.completed")).toBeGreaterThan(
      eventTypes(sink).indexOf("tool_call.completed"),
    );
    expect(sink.events.at(-1)?.type).toBe("turn.completed");
  });

  it("retries a transient terminal append without duplicating settlement", async () => {
    const sink = new FailingCompletedSettlementSink(1);
    const kernel = await createKernel(sink);

    await expect(kernel.startTurn({ run, turn, runAttemptId })).resolves.toMatchObject({
      status: "completed",
    });

    expect(terminalEvents(sink)).toHaveLength(1);
    expect(sink.events.at(-1)?.type).toBe("turn.completed");
  });

  it("recovers exhausted completion settlement as one failed outcome", async () => {
    const sink = new FailingCompletedSettlementSink(2);
    const kernel = await createKernel(sink);

    await expect(kernel.startTurn({ run, turn, runAttemptId })).rejects.toBeInstanceOf(
      RuntimeLifecycleSettlementError,
    );

    expect(eventTypes(sink).slice(-2)).toEqual([
      "run_attempt.failed",
      "turn.failed",
    ]);
    expect(terminalEvents(sink)).toHaveLength(1);
  });

  it("rejects a second runtime owner for an accepted turn", async () => {
    const kernel = await createKernel(createLifecycleSink());
    await kernel.startTurn({ run, turn, runAttemptId });

    await expect(kernel.startTurn({ run, turn, runAttemptId })).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeKernelError>>({
        code: "turn_already_owned",
      }),
    );
  });

  it("does not duplicate terminal events when a new kernel retries the turn", async () => {
    const sink = createLifecycleSink();
    await (await createKernel(sink)).startTurn({ run, turn, runAttemptId });

    await (await createKernel(sink)).startTurn({ run, turn, runAttemptId });

    expect(terminalEvents(sink)).toHaveLength(1);
    expect(sink.events).toHaveLength(8);
  });

  it("settles provider disconnect as failure rather than completion", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => {
      throw new Error("stream disconnected");
    });
    const kernel = await createKernel(sink, ports);

    await expect(kernel.startTurn({ run, turn, runAttemptId })).rejects.toThrow(
      "stream disconnected",
    );

    expect(sink.events.at(-1)?.type).toBe("turn.failed");
    expect(eventTypes(sink)).not.toContain("turn.completed");
  });

  it("interrupts active tool work and rejects its later completion write", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    const worker = deferred<Awaited<ReturnType<typeof ports.worker.executeTool>>>();
    ports.provider.generateNext = vi.fn(async () => toolStep());
    ports.worker.executeTool = vi.fn(() => worker.promise);
    const kernel = await createKernel(sink, ports);
    const execution = kernel.startTurn({ run, turn, runAttemptId });
    await vi.waitFor(() => expect(ports.worker.executeTool).toHaveBeenCalled());

    await kernel.interruptTurn(turn.id, "User cancelled the turn");
    worker.resolve({ kind: "completed", output: { ok: true } });

    await expect(execution).rejects.toBeInstanceOf(LifecycleTransitionError);
    expect(eventTypes(sink).slice(-4)).toEqual([
      "tool_call.interrupted",
      "item.interrupted",
      "run_attempt.interrupted",
      "turn.interrupted",
    ]);
  });

  it("serializes an interrupt racing tool completion without conflicting settlement", async () => {
    const sink = new BlockingToolCompletionSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce(toolStep())
      .mockResolvedValueOnce({ kind: "complete", itemId: finalItemId, output: "Done" });
    const kernel = await createKernel(sink, ports);
    const execution = kernel.startTurn({ run, turn, runAttemptId });
    await sink.waitUntilBlocked();

    const interruption = kernel.interruptTurn(turn.id, "User cancelled the turn");
    sink.release();
    await interruption;

    await expect(execution).rejects.toBeInstanceOf(LifecycleTransitionError);
    expect(eventTypes(sink).filter((type) => type === "tool_call.completed")).toHaveLength(1);
    expect(eventTypes(sink)).not.toContain("tool_call.interrupted");
    expect(sink.events.map((event) => event.sequence)).toEqual(
      sink.events.map((_, index) => index + 1),
    );
    expect(sink.events.at(-1)?.type).toBe("turn.interrupted");
  });
});

async function createKernel(
  lifecycleEvents: LifecycleEventSink,
  ports = createPorts(),
): Promise<RuntimeKernel> {
  return new RuntimeKernel({
    lifecycleEvents,
    workspaceManifests: await createManifestRepository(),
    ...ports,
    producerId: "runtime-kernel-test",
    clock: { now: () => timestamp },
  });
}

function toolStep() {
  return {
    kind: "tool_call" as const,
    itemId: ItemIdSchema.parse("itm_runtime001"),
    content: {
      toolCallId: ToolCallIdSchema.parse("toolcall_runtime001"),
      toolName: "write_file",
      input: { path: "src/index.ts" },
    },
  };
}

function protocolFailure(message: string) {
  return {
    code: "command_failed" as const,
    message,
    retryable: false,
    correlationId: null,
    details: null,
  };
}

function eventTypes(sink: MemoryLifecycleEventSink): string[] {
  return sink.events.map((event) => event.type);
}

function terminalEvents(sink: MemoryLifecycleEventSink): LifecycleEvent[] {
  return sink.events.filter((event) =>
    ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type),
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

class FailingCompletedSettlementSink extends MemoryLifecycleEventSink {
  constructor(private remainingFailures: number) {
    super();
  }

  override async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    if (
      this.remainingFailures > 0 &&
      events.some((event) => event.type === "turn.completed")
    ) {
      this.remainingFailures -= 1;
      throw new Error("simulated atomic append failure");
    }
    return await super.appendBatch(events);
  }
}

class BlockingToolCompletionSink extends MemoryLifecycleEventSink {
  private readonly blocked = deferred<void>();
  private readonly released = deferred<void>();
  private shouldBlock = true;

  async waitUntilBlocked(): Promise<void> {
    await this.blocked.promise;
  }

  release(): void {
    this.released.resolve(undefined);
  }

  override async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    if (this.shouldBlock && events.some((event) => event.type === "tool_call.completed")) {
      this.shouldBlock = false;
      this.blocked.resolve(undefined);
      await this.released.promise;
    }
    return await super.appendBatch(events);
  }
}
