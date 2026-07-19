import { JsonRecordSchema } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import { RuntimeLifecycleCoordinator } from "./RuntimeLifecycleCoordinator.js";
import {
  createLifecycleSink,
  run,
  runAttemptId,
  turn,
} from "./test-fixtures.js";

describe("RuntimeLifecycleCoordinator hook audits", () => {
  it("allocates hook event identity and sequence at the canonical lifecycle owner", async () => {
    const sink = createLifecycleSink();
    const coordinator = new RuntimeLifecycleCoordinator({
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      turnId: turn.id,
      runAttemptId,
      sink,
      producerId: "runtime-hook-test",
      clock: { now: () => "2026-07-18T10:00:00.000Z" },
    });
    await coordinator.start();

    await coordinator.appendHookAudit(
      "hook.invocation.completed",
      createAudit(),
    );

    expect(sink.events.at(-1)).toMatchObject({
      type: "hook.invocation.completed",
      sequence: 4,
      producer: { kind: "runtime_kernel", id: "runtime-hook-test" },
      payload: {
        invocation: {
          handlerId: "project.audit",
          status: "completed",
        },
      },
    });
    expect(JSON.stringify(sink.events)).not.toContain("raw hook output");
  });
});

function createAudit() {
  return JsonRecordSchema.parse({
    eventType: "hook.invocation.completed",
    invocation: {
      invocationId: "hki_runtime01",
      eventId: "evt_trigger01",
      runId: "run_runtime001",
      threadId: "thr_runtime001",
      handlerId: "project.audit",
      source: "project",
      order: 0,
      eventName: "UserPromptSubmit",
      startedAt: "2026-07-18T10:00:00.000Z",
      completedAt: "2026-07-18T10:00:00.025Z",
      status: "completed",
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64),
      errorCode: null,
      errorMessage: null,
    },
    outcomeSummary: {
      eventName: "UserPromptSubmit",
      status: "continue",
      cleanupStatus: null,
      addedContextCount: 0,
      hasUserVisibleMessage: false,
    },
    metadata: { durationMs: 25, cleanupStatus: null },
    emittedAt: "2026-07-18T10:00:00.025Z",
  });
}
