import { describe, expect, it } from "vitest";
import { HookDispatcher } from "./dispatcher.js";
import type { SessionStartOutcome } from "./outcomes.js";
import { createSessionStartRequest } from "./testSupport.js";

const continueOutcome: SessionStartOutcome = {
  status: "continue",
  userVisibleMessage: null,
  modelContextAdditions: [],
  auditMetadata: {},
};

describe("HookDispatcher", () => {
  it("runs enabled internal handlers by deterministic order", async () => {
    const dispatcher = new HookDispatcher();
    const calls: string[] = [];

    dispatcher.register(registration("system.second", 20), async () =>
      recordCall(calls, "second"),
    );
    dispatcher.register(registration("system.first", 10), async () =>
      recordCall(calls, "first"),
    );

    const result = await dispatcher.dispatch(
      "SessionStart",
      createSessionStartRequest(),
    );

    expect(calls).toEqual(["first", "second"]);
    expect(result.outcomes).toHaveLength(2);
  });

  it("emits started, completed, and applied audit events", async () => {
    const dispatcher = new HookDispatcher();
    dispatcher.register(registration("system.context", 0), async () => ({
      ...continueOutcome,
      auditMetadata: { source: "test" },
    }));

    const result = await dispatcher.dispatch(
      "SessionStart",
      createSessionStartRequest(),
    );

    expect(result.auditEvents.map((event) => event.eventType)).toEqual([
      "hook.invocation.started",
      "hook.invocation.completed",
      "hook.outcome.applied",
    ]);
    expect(result.auditEvents[1]?.invocation.status).toBe("completed");
    expect(result.auditEvents[1]?.invocation.outputHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("continues after failed handlers when configured to continue", async () => {
    const dispatcher = new HookDispatcher();
    const calls: string[] = [];

    dispatcher.register(registration("system.fail", 0), async () => {
      throw new Error("handler failed");
    });
    dispatcher.register(registration("system.after_fail", 10), async () =>
      recordCall(calls, "after_fail"),
    );

    const result = await dispatcher.dispatch(
      "SessionStart",
      createSessionStartRequest(),
    );

    expect(calls).toEqual(["after_fail"]);
    expect(result.outcomes).toHaveLength(1);
    expect(result.auditEvents.map((event) => event.eventType)).toContain(
      "hook.invocation.failed",
    );
  });

  it("stops dispatch after timeout when configured to stop", async () => {
    const dispatcher = new HookDispatcher();
    const calls: string[] = [];

    dispatcher.register(
      {
        ...registration("system.timeout", 0),
        timeoutMs: 1,
        failurePolicy: "stop_dispatch",
      },
      async () => {
        await delay(20);
        return continueOutcome;
      },
    );
    dispatcher.register(registration("system.after_timeout", 10), async () =>
      recordCall(calls, "after_timeout"),
    );

    const result = await dispatcher.dispatch(
      "SessionStart",
      createSessionStartRequest(),
    );

    expect(calls).toEqual([]);
    expect(result.outcomes).toHaveLength(0);
    expect(result.auditEvents.map((event) => event.eventType)).toContain(
      "hook.invocation.timed_out",
    );
  });
});

function registration(id: string, order: number) {
  return {
    id,
    eventName: "SessionStart" as const,
    displayName: id,
    enabled: true,
    order,
    timeoutMs: 1_000,
    failurePolicy: "continue" as const,
  };
}

function recordCall(calls: string[], label: string): SessionStartOutcome {
  calls.push(label);
  return continueOutcome;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
