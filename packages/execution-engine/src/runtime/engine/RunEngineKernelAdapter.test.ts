import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import type { RuntimeLifecycleEventStore } from "@repo/runtime-kernel";
import { executeRunEngineThroughRuntimeKernel } from "./RunEngineKernelAdapter.js";

describe("RunEngineKernelAdapter", () => {
  it("routes live RunEngine execution through RuntimeKernel lifecycle settlement", async () => {
    const lifecycleEvents = new CapturingLifecycleEventStore();
    const response = new Response("ok", { status: 202 });
    const executed: string[] = [];

    const result = await executeRunEngineThroughRuntimeKernel({
      runId: "run_adapter001",
      sessionId: "session-adapter-1",
      userId: "user-adapter-1",
      workspaceId: "workspace-adapter-1",
      correlationId: "corr-adapter-1",
      input: {
        mode: "build",
        agentType: "coding",
        prompt: "test",
        sessionId: "session-adapter-1",
        providerId: "openai",
        modelId: "gpt-5",
      },
      tools: {},
      lifecycleEvents,
      now: () => "2026-06-30T12:00:00.000Z",
      executeLegacyRunEngine: async () => {
        executed.push("legacy");
        return response;
      },
    });

    expect(result).toBe(response);
    expect(executed).toEqual(["legacy"]);
    expect(lifecycleEvents.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "turn.queued",
        "turn.started",
        "run_attempt.started",
        "workspace.snapshot_captured",
        "assistant_message.delta",
        "turn.completed",
      ]),
    );
    expect(
      lifecycleEvents.events.find((event) => event.type === "turn.completed")
        ?.payload,
    ).toMatchObject({ outcome: { status: "completed" } });
  });
});

class CapturingLifecycleEventStore implements RuntimeLifecycleEventStore {
  readonly events: LifecycleEvent[] = [];

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    return (await this.appendBatch([event]))[0] as LifecycleEvent;
  }

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    this.events.push(...events);
    return events;
  }

  async replay(input: {
    turnId: LifecycleEvent["turnId"];
    afterSequence: number | null;
    limit: number;
  }): Promise<{
    events: readonly LifecycleEvent[];
    nextSequence: number | null;
  }> {
    const afterSequence = input.afterSequence ?? 0;
    const events = this.events
      .filter((event) => event.turnId === input.turnId)
      .filter((event) => event.sequence > afterSequence)
      .slice(0, input.limit);
    return { events, nextSequence: events.at(-1)?.sequence ?? null };
  }
}
