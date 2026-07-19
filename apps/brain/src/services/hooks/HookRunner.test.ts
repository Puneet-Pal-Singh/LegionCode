import {
  HookRuntimeContextSchema,
  type HookAuditAppendInput,
  type HookInvocationId,
  type PrivateAlphaHookEventName,
} from "@repo/hook-protocol";
import type { EventId } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import { HookRegistry } from "./HookRegistry";
import { HookRunner } from "./HookRunner";
import { WebCryptoHookPayloadDigester } from "./HookRuntimeDefaults";
import type {
  HookAuditSink,
  HookClock,
  HookExecutionInput,
  HookExecutorPort,
  HookInvocationIdFactory,
  HookPayloadDigester,
  HookScopeAuthorizer,
} from "./HookRuntimePorts";

const context = HookRuntimeContextSchema.parse({
  threadId: "thr_abcdef",
  runId: "run_abcdef",
  turnId: "trn_abcdef",
  workspaceId: "wrk_abcdef",
  workspaceRoot: "/home/sandbox/runs/run_abcdef",
  executionLocation: "cloud_sandbox",
  backendId: "cloudflare_sandbox",
  modelId: "gpt-5",
  providerId: "openai",
  permissionMode: "ask",
  capabilityManifestId: "wsm_abcdef",
  transcriptRef: null,
});

const sessionStartRequest = {
  context,
  source: "new_session" as const,
  initialWorkspaceManifestRef: null,
  capabilityManifestRef: "manifests/wsm_abcdef.json",
};

const baseDefinition = {
  handlerId: "project.session",
  eventName: "SessionStart" as const,
  source: "project" as const,
  displayName: "Project session hook",
  enabled: true,
  order: 10,
  timeoutMs: 100,
  configurationKey: "project:hooks/session",
};

describe("HookRunner", () => {
  it("executes in registry order and audits summaries without payload content", async () => {
    const executionOrder: string[] = [];
    const cleanupOrder: string[] = [];
    const executor: HookExecutorPort = {
      async execute<EventName extends PrivateAlphaHookEventName>(
        input: HookExecutionInput<EventName>,
      ): Promise<unknown> {
        executionOrder.push(input.definition.handlerId);
        return {
          status: "continue",
          userVisibleMessage: "TOP_SECRET",
          modelContextAdditions: [],
          auditMetadata: { internal: "TOP_SECRET" },
        };
      },
      async cleanup(input): Promise<void> {
        cleanupOrder.push(input.definition.handlerId);
      },
    };
    const fixture = createRunner(
      [
        { ...baseDefinition, handlerId: "user.late", source: "user", order: 20 },
        { ...baseDefinition, handlerId: "plugin.middle", source: "plugin" },
        baseDefinition,
        { ...baseDefinition, handlerId: "project.off", enabled: false, order: 0 },
      ],
      executor,
    );

    const result = await fixture.runner.run(
      "SessionStart",
      sessionStartRequest,
      { triggerEventId: "evt_trigger1" as EventId },
    );

    expect(executionOrder).toEqual([
      "project.session",
      "plugin.middle",
      "user.late",
    ]);
    expect(cleanupOrder).toEqual(executionOrder);
    expect(result.handlers.map((handler) => handler.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(fixture.audits).toHaveLength(6);
    expect(fixture.audits[1]?.outcomeSummary).toEqual({
      eventName: "SessionStart",
      status: "continue",
      hasUserVisibleMessage: true,
      addedContextCount: 0,
      cleanupStatus: null,
    });
    expect(JSON.stringify(fixture.audits)).not.toContain("TOP_SECRET");
  });

  it("sanitizes a handler failure and continues with the next hook", async () => {
    const calls: string[] = [];
    const executor: HookExecutorPort = {
      async execute<EventName extends PrivateAlphaHookEventName>(
        input: HookExecutionInput<EventName>,
      ): Promise<unknown> {
        calls.push(input.definition.handlerId);
        if (input.definition.handlerId === "project.first") {
          throw new Error("sensitive executor detail");
        }
        return continueOutcome();
      },
      async cleanup(): Promise<void> {},
    };
    const fixture = createRunner(
      [
        { ...baseDefinition, handlerId: "project.first", order: 0 },
        { ...baseDefinition, handlerId: "project.second", order: 1 },
      ],
      executor,
    );

    const result = await fixture.runner.run(
      "SessionStart",
      sessionStartRequest,
      { triggerEventId: "evt_trigger1" as EventId },
    );

    expect(calls).toEqual(["project.first", "project.second"]);
    expect(result.handlers.map((handler) => handler.status)).toEqual([
      "failed",
      "completed",
    ]);
    expect(result.handlers[0]?.error).toEqual({
      code: "HOOK_EXECUTION_FAILED",
      message: "Hook handler failed.",
    });
    expect(JSON.stringify(fixture.audits)).not.toContain(
      "sensitive executor detail",
    );
  });

  it("aborts a timed-out handler, cleans it up, and continues", async () => {
    let timedOutSignal: AbortSignal | undefined;
    const cleaned: string[] = [];
    const executor: HookExecutorPort = {
      async execute<EventName extends PrivateAlphaHookEventName>(
        input: HookExecutionInput<EventName>,
      ): Promise<unknown> {
        if (input.definition.handlerId === "project.slow") {
          timedOutSignal = input.signal;
          return await new Promise<unknown>(() => undefined);
        }
        return continueOutcome();
      },
      async cleanup(input): Promise<void> {
        cleaned.push(`${input.definition.handlerId}:${input.reason}`);
      },
    };
    const fixture = createRunner(
      [
        {
          ...baseDefinition,
          handlerId: "project.slow",
          timeoutMs: 50,
          order: 0,
        },
        { ...baseDefinition, handlerId: "project.next", order: 1 },
      ],
      executor,
    );

    const result = await fixture.runner.run(
      "SessionStart",
      sessionStartRequest,
      { triggerEventId: "evt_trigger1" as EventId },
    );

    expect(timedOutSignal?.aborted).toBe(true);
    expect(result.handlers.map((handler) => handler.status)).toEqual([
      "timed_out",
      "completed",
    ]);
    expect(cleaned).toEqual([
      "project.slow:timed_out",
      "project.next:completed",
    ]);
  });

  it("cancels the active hook, cleans it up, and does not start siblings", async () => {
    const calls: string[] = [];
    const cleaned: string[] = [];
    const controller = new AbortController();
    const executor: HookExecutorPort = {
      async execute<EventName extends PrivateAlphaHookEventName>(
        input: HookExecutionInput<EventName>,
      ): Promise<unknown> {
        calls.push(input.definition.handlerId);
        queueMicrotask(() => controller.abort());
        return await new Promise<unknown>(() => undefined);
      },
      async cleanup(input): Promise<void> {
        cleaned.push(input.reason);
      },
    };
    const fixture = createRunner(
      [
        { ...baseDefinition, handlerId: "project.active", order: 0 },
        { ...baseDefinition, handlerId: "project.never", order: 1 },
      ],
      executor,
    );

    const result = await fixture.runner.run(
      "SessionStart",
      sessionStartRequest,
      {
        triggerEventId: "evt_trigger1" as EventId,
        signal: controller.signal,
      },
    );

    expect(calls).toEqual(["project.active"]);
    expect(cleaned).toEqual(["cancelled"]);
    expect(result.handlers[0]?.status).toBe("cancelled");
    expect(fixture.audits.at(-1)?.eventType).toBe(
      "hook.invocation.cancelled",
    );
  });

  it("turns cleanup failure into a sanitized failed invocation", async () => {
    const executor: HookExecutorPort = {
      async execute(): Promise<unknown> {
        return continueOutcome();
      },
      async cleanup(): Promise<void> {
        throw new Error("secret cleanup failure");
      },
    };
    const fixture = createRunner([baseDefinition], executor);

    const result = await fixture.runner.run(
      "SessionStart",
      sessionStartRequest,
      { triggerEventId: "evt_trigger1" as EventId },
    );

    expect(result.handlers[0]).toMatchObject({
      status: "failed",
      error: {
        code: "HOOK_CLEANUP_FAILED",
        message: "Hook cleanup failed.",
      },
    });
    expect(fixture.audits.at(-1)).toMatchObject({
      eventType: "hook.invocation.failed",
      outcomeSummary: null,
      metadata: { cleanupStatus: "failed" },
    });
    expect(JSON.stringify(fixture.audits)).not.toContain("secret cleanup");
  });

  it("does not execute or audit hooks before server task scope is authorized", async () => {
    let executed = false;
    const executor: HookExecutorPort = {
      async execute(): Promise<unknown> {
        executed = true;
        return continueOutcome();
      },
      async cleanup(): Promise<void> {},
    };
    const fixture = createRunner([baseDefinition], executor, {
      async assertAuthorized(): Promise<void> {
        throw new Error("scope denied");
      },
    });

    await expect(
      fixture.runner.run("SessionStart", sessionStartRequest, {
        triggerEventId: "evt_trigger1" as EventId,
      }),
    ).rejects.toThrow("scope denied");
    expect(executed).toBe(false);
    expect(fixture.audits).toEqual([]);
  });

  it("uses canonical SHA-256 hashing independent of object key order", async () => {
    const digester = new WebCryptoHookPayloadDigester();
    expect(await digester.digest({ b: 2, a: 1 })).toBe(
      await digester.digest({ a: 1, b: 2 }),
    );
    expect(await digester.digest({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
});

function createRunner(
  definitions: readonly unknown[],
  executor: HookExecutorPort,
  scopeAuthorizerOverride?: HookScopeAuthorizer,
): {
  runner: HookRunner;
  audits: HookAuditAppendInput[];
} {
  const audits: HookAuditAppendInput[] = [];
  let invocationCounter = 0;
  let now = Date.parse("2026-07-18T12:00:00.000Z");
  const auditSink: HookAuditSink = {
    async append(input): Promise<void> {
      audits.push(input);
    },
  };
  const digester: HookPayloadDigester = {
    async digest(value): Promise<string> {
      return JSON.stringify(value).includes("status")
        ? "b".repeat(64)
        : "a".repeat(64);
    },
  };
  const invocationIds: HookInvocationIdFactory = {
    next(): HookInvocationId {
      invocationCounter += 1;
      return `hki_abcdef${invocationCounter}`;
    },
  };
  const clock: HookClock = {
    nowMs(): number {
      now += 1;
      return now;
    },
  };
  const scopeAuthorizer: HookScopeAuthorizer = scopeAuthorizerOverride ?? {
    async assertAuthorized(): Promise<void> {},
  };
  return {
    audits,
    runner: new HookRunner({
      registry: new HookRegistry(definitions),
      executor,
      auditSink,
      digester,
      invocationIds,
      clock,
      scopeAuthorizer,
    }),
  };
}

function continueOutcome(): unknown {
  return {
    status: "continue",
    userVisibleMessage: null,
    modelContextAdditions: [],
    auditMetadata: {},
  };
}
