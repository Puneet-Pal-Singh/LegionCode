import { LifecycleEventSchema, type LifecycleEvent } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import {
  HookAuditProjectionError,
  applyHookAuditLifecycleEvent,
  buildHookSettingsAuditReadModel,
  createHookAuditProjection,
  replayHookAuditLifecycleEvents,
} from "./hook-audit-projection.js";

describe("hook audit lifecycle projection", () => {
  it("uses one reducer for replay and live continuation", () => {
    const started = hookEvent(1, "hook.invocation.started", "running");
    const completed = hookEvent(2, "hook.invocation.completed", "completed");

    const replayed = replayHookAuditLifecycleEvents([started, completed]);
    const continued = applyHookAuditLifecycleEvent(
      applyHookAuditLifecycleEvent(createHookAuditProjection(), started),
      completed,
    );

    expect(continued).toEqual(replayed);
    expect(replayed.events).toHaveLength(1);
    expect(replayed.events[0]?.invocation.status).toBe("completed");
    expect(replayed.events[0]?.eventSequence).toBe(2);
  });

  it("builds a settings audit read model without inventing configuration state", () => {
    const projection = replayHookAuditLifecycleEvents([
      hookEvent(1, "hook.invocation.completed", "completed"),
      hookEvent(2, "hook.invocation.failed", "failed", {
        invocationId: "hki_second01",
        handlerId: "project.format",
        errorCode: "HOOK_EXECUTION_FAILED",
        errorMessage: "The hook could not complete.",
      }),
    ]);

    expect(buildHookSettingsAuditReadModel(projection)).toEqual([
      expect.objectContaining({
        handlerId: "project.format",
        source: "project",
        eventName: "UserPromptSubmit",
        lastStatus: "failed",
        lastError: {
          code: "HOOK_EXECUTION_FAILED",
          message: "The hook could not complete.",
        },
      }),
    ]);
    expect(buildHookSettingsAuditReadModel(projection)[0]).not.toHaveProperty(
      "enabled",
    );
    expect(buildHookSettingsAuditReadModel(projection)[0]).not.toHaveProperty(
      "configurationKey",
    );
  });

  it("rejects a hook payload whose event type disagrees with its envelope", () => {
    const event = hookEvent(1, "hook.invocation.started", "running");
    const corrupted = {
      ...event,
      payload: { ...event.payload, eventType: "hook.invocation.completed" },
    } as LifecycleEvent;

    expect(() =>
      applyHookAuditLifecycleEvent(createHookAuditProjection(), corrupted),
    ).toThrow(HookAuditProjectionError);
  });

  it("rejects cross-thread audits and terminal-to-running regressions", () => {
    const started = hookEvent(1, "hook.invocation.started", "running");
    const crossThread = {
      ...started,
      payload: {
        ...started.payload,
        invocation: {
          ...((started.payload as Record<string, unknown>)
            .invocation as Record<string, unknown>),
          threadId: "thr_otherthread01",
        },
      },
    } as LifecycleEvent;
    expect(() =>
      applyHookAuditLifecycleEvent(createHookAuditProjection(), crossThread),
    ).toThrow(HookAuditProjectionError);

    const completed = hookEvent(1, "hook.invocation.completed", "completed");
    const lateStarted = hookEvent(2, "hook.invocation.started", "running");
    expect(() =>
      applyHookAuditLifecycleEvent(
        applyHookAuditLifecycleEvent(
          createHookAuditProjection(),
          completed,
        ),
        lateStarted,
      ),
    ).toThrow(HookAuditProjectionError);
  });

  it("ignores unrelated lifecycle events", () => {
    const event = LifecycleEventSchema.parse({
      ...envelope(1),
      type: "turn.started",
      payload: {},
    });

    const initial = createHookAuditProjection();
    expect(applyHookAuditLifecycleEvent(initial, event)).toBe(initial);
  });
});

function hookEvent(
  sequence: number,
  type:
    | "hook.invocation.started"
    | "hook.invocation.completed"
    | "hook.invocation.failed",
  status: "running" | "completed" | "failed",
  overrides: {
    invocationId?: string;
    handlerId?: string;
    errorCode?: string;
    errorMessage?: string;
  } = {},
): LifecycleEvent {
  const isCompleted = status === "completed";
  const isRunning = status === "running";
  return LifecycleEventSchema.parse({
    ...envelope(sequence),
    type,
    payload: {
      eventType: type,
      invocation: {
        invocationId: overrides.invocationId ?? "hki_primary01",
        eventId: "evt_trigger01",
        runId: "run_hookrun01",
        threadId: "thr_hookthread01",
        handlerId: overrides.handlerId ?? "project.format",
        source: "project",
        order: 10,
        eventName: "UserPromptSubmit",
        startedAt: "2026-07-18T10:00:00.000Z",
        completedAt: isRunning ? null : "2026-07-18T10:00:00.025Z",
        status,
        inputHash: "a".repeat(64),
        outputHash: isCompleted ? "b".repeat(64) : null,
        errorCode:
          overrides.errorCode ??
          (status === "failed" ? "HOOK_EXECUTION_FAILED" : null),
        errorMessage:
          overrides.errorMessage ??
          (status === "failed" ? "The hook could not complete." : null),
      },
      outcomeSummary: isCompleted
        ? {
            eventName: "UserPromptSubmit",
            status: "continue",
            cleanupStatus: null,
            addedContextCount: 0,
            hasUserVisibleMessage: false,
          }
        : null,
      metadata: {
        durationMs: isRunning ? null : 25,
        cleanupStatus: null,
      },
      emittedAt: "2026-07-18T10:00:00.025Z",
    },
  });
}

function envelope(sequence: number) {
  return {
    eventId: `evt_audit${String(sequence).padStart(2, "0")}`,
    threadId: "thr_hookthread01",
    turnId: "trn_hookturn01",
    runAttemptId: "attempt_hook01",
    sequence,
    idempotencyKey: `hook-audit-${sequence}`,
    producer: { kind: "runtime_kernel", id: "hook-test" },
    schemaVersion: 1,
    createdAt: `2026-07-18T10:00:00.0${sequence}Z`,
  };
}
