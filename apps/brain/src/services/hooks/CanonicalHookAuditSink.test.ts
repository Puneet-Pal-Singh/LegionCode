import {
  HookAuditAppendInputSchema,
  type HookAuditAppendInput,
} from "@repo/hook-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  CanonicalHookAuditSink,
  HookAuditScopeError,
} from "./CanonicalHookAuditSink.js";

describe("CanonicalHookAuditSink", () => {
  it("forwards a validated audit only through the bound runtime appender", async () => {
    const appendHookAudit = vi.fn(async () => {});
    const sink = new CanonicalHookAuditSink(
      { runId: "run_hookrun01", threadId: "thr_hookthread01" },
      { appendHookAudit },
    );
    const audit = createAudit();

    await sink.append(audit);

    expect(appendHookAudit).toHaveBeenCalledOnce();
    expect(appendHookAudit).toHaveBeenCalledWith(audit.eventType, audit);
  });

  it("rejects cross-run or cross-thread audit data before append", async () => {
    const appendHookAudit = vi.fn(async () => {});
    const sink = new CanonicalHookAuditSink(
      { runId: "run_other001", threadId: "thr_hookthread01" },
      { appendHookAudit },
    );

    await expect(sink.append(createAudit())).rejects.toBeInstanceOf(
      HookAuditScopeError,
    );
    expect(appendHookAudit).not.toHaveBeenCalled();
  });

  it("does not allow outcome application to enter lifecycle truth", async () => {
    const appendHookAudit = vi.fn(async () => {});
    const sink = new CanonicalHookAuditSink(
      { runId: "run_hookrun01", threadId: "thr_hookthread01" },
      { appendHookAudit },
    );

    await expect(
      sink.append({
        ...createAudit(),
        eventType: "hook.outcome.applied",
      }),
    ).rejects.toThrow();
    expect(appendHookAudit).not.toHaveBeenCalled();
  });
});

function createAudit(): HookAuditAppendInput {
  return HookAuditAppendInputSchema.parse({
    eventType: "hook.invocation.completed",
    invocation: {
      invocationId: "hki_sinktest01",
      eventId: "evt_trigger01",
      runId: "run_hookrun01",
      threadId: "thr_hookthread01",
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
