import {
  HookInvocationSchema,
  HookOutcomeSchemaByEventName,
  HookRequestSchemaByEventName,
  type HookAuditAppendInput,
  type HookAuditEventType,
  type HookDefinition,
  type HookInvocation,
  type HookInvocationId,
  type HookOutcomeByEventName,
  type HookOutcomeSummary,
  type HookRequestByEventName,
  type PrivateAlphaHookEventName,
} from "@repo/hook-protocol";
import { EventIdSchema, type EventId } from "@repo/platform-protocol";
import { HookRegistry } from "./HookRegistry";
import type {
  HookAuditSink,
  HookClock,
  HookExecutionCleanupReason,
  HookExecutorPort,
  HookHandlerRunResult,
  HookInvocationIdFactory,
  HookPayloadDigester,
  HookRunResult,
  HookScopeAuthorizer,
} from "./HookRuntimePorts";

export interface RunHooksOptions {
  triggerEventId: EventId;
  signal?: AbortSignal;
}

export interface HookRunnerDependencies {
  registry: HookRegistry;
  executor: HookExecutorPort;
  auditSink: HookAuditSink;
  digester: HookPayloadDigester;
  invocationIds: HookInvocationIdFactory;
  clock: HookClock;
  scopeAuthorizer: HookScopeAuthorizer;
}

const CLEANUP_TIMEOUT_MS = 1_000;

/**
 * Executes trusted handlers and reports proposals. It never applies outcomes or
 * settles runtime lifecycle state; those responsibilities stay with the caller.
 */
export class HookRunner {
  constructor(private readonly dependencies: HookRunnerDependencies) {}

  async run<EventName extends PrivateAlphaHookEventName>(
    eventName: EventName,
    request: HookRequestByEventName[EventName],
    options: RunHooksOptions,
  ): Promise<HookRunResult<EventName>> {
    const validatedRequest = parseRequest(eventName, request);
    const triggerEventId = EventIdSchema.parse(options.triggerEventId);
    await this.dependencies.scopeAuthorizer.assertAuthorized(
      validatedRequest.context,
    );
    const handlers: HookHandlerRunResult<EventName>[] = [];

    for (const definition of this.dependencies.registry.enabledFor(eventName)) {
      if (options.signal?.aborted) break;
      const result = await this.runHandler(
        eventName,
        definition,
        validatedRequest,
        triggerEventId,
        options.signal,
      );
      handlers.push(result);
      if (result.status === "cancelled") break;
    }

    return Object.freeze({ eventName, handlers: Object.freeze(handlers) });
  }

  private async runHandler<EventName extends PrivateAlphaHookEventName>(
    eventName: EventName,
    definition: HookDefinition,
    request: HookRequestByEventName[EventName],
    triggerEventId: EventId,
    parentSignal: AbortSignal | undefined,
  ): Promise<HookHandlerRunResult<EventName>> {
    const startedAtMs = this.dependencies.clock.nowMs();
    const invocationId = this.dependencies.invocationIds.next();
    const inputHash = await this.dependencies.digester.digest(request);
    const startedInvocation = buildInvocation({
      invocationId,
      triggerEventId,
      definition,
      request,
      startedAtMs,
      status: "running",
      completedAtMs: null,
      inputHash,
      outputHash: null,
      error: null,
    });
    await this.appendAudit(
      "hook.invocation.started",
      startedInvocation,
      null,
      null,
    );

    const executionController = new AbortController();
    let outcome: HookOutcomeByEventName[EventName] | null = null;
    let outputHash: string | null = null;
    let failure: HookFailure | null = null;

    try {
      const rawOutcome = await waitForExecution({
        execute: () =>
          this.dependencies.executor.execute({
            definition: definition as HookDefinition & {
              eventName: EventName;
            },
            request,
            signal: executionController.signal,
          }),
        controller: executionController,
        parentSignal,
        timeoutMs: definition.timeoutMs,
      });
      outcome = parseOutcome(eventName, rawOutcome);
      outputHash = await this.dependencies.digester.digest(outcome);
    } catch (error) {
      failure = toSafeFailure(error);
    }

    const cleanupReason = toCleanupReason(failure);
    const cleanupStatus = await this.cleanup(
      definition,
      invocationId,
      cleanupReason,
    );
    if (cleanupStatus === "failed" && failure === null) {
      failure = {
        status: "failed",
        code: "HOOK_CLEANUP_FAILED",
        message: "Hook cleanup failed.",
      };
      outcome = null;
    }

    const completedAtMs = this.dependencies.clock.nowMs();
    if (failure !== null) {
      const failedInvocation = buildInvocation({
        invocationId,
        triggerEventId,
        definition,
        request,
        startedAtMs,
        completedAtMs,
        status: failure.status,
        inputHash,
        outputHash,
        error: failure,
      });
      await this.appendAudit(
        toAuditEventType(failure.status),
        failedInvocation,
        null,
        cleanupStatus,
      );
      return {
        definition,
        invocationId,
        status: failure.status,
        outcome: null,
        error: { code: failure.code, message: failure.message },
      };
    }

    if (outcome === null || outputHash === null) {
      throw new Error("Hook runner completed without a validated outcome.");
    }
    const completedInvocation = buildInvocation({
      invocationId,
      triggerEventId,
      definition,
      request,
      startedAtMs,
      completedAtMs,
      status: "completed",
      inputHash,
      outputHash,
      error: null,
    });
    await this.appendAudit(
      "hook.invocation.completed",
      completedInvocation,
      summarizeOutcome(eventName, outcome),
      cleanupStatus,
    );
    return {
      definition,
      invocationId,
      status: "completed",
      outcome,
      error: null,
    };
  }

  private async cleanup(
    definition: HookDefinition,
    invocationId: HookInvocationId,
    reason: HookExecutionCleanupReason,
  ): Promise<"completed" | "failed"> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.dependencies.executor.cleanup({
          definition,
          invocationId,
          reason,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("cleanup timed out"));
          }, Math.min(CLEANUP_TIMEOUT_MS, definition.timeoutMs));
        }),
      ]);
      return "completed";
    } catch {
      return "failed";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async appendAudit(
    eventType: HookAuditEventType,
    invocation: HookInvocation,
    outcomeSummary: HookOutcomeSummary | null,
    cleanupStatus: "completed" | "failed" | null,
  ): Promise<void> {
    const completedAtMs = invocation.completedAt
      ? Date.parse(invocation.completedAt)
      : null;
    const startedAtMs = Date.parse(invocation.startedAt);
    const input: HookAuditAppendInput = {
      eventType,
      invocation,
      outcomeSummary,
      metadata: {
        durationMs:
          completedAtMs === null
            ? null
            : Math.max(0, completedAtMs - startedAtMs),
        cleanupStatus,
      },
      emittedAt: toTimestamp(this.dependencies.clock.nowMs()),
    };
    await this.dependencies.auditSink.append(input);
  }
}

interface BuildInvocationInput {
  invocationId: HookInvocationId;
  triggerEventId: EventId;
  definition: HookDefinition;
  request: HookRequestByEventName[PrivateAlphaHookEventName];
  startedAtMs: number;
  completedAtMs: number | null;
  status: HookInvocation["status"];
  inputHash: string;
  outputHash: string | null;
  error: HookFailure | null;
}

function buildInvocation(input: BuildInvocationInput): HookInvocation {
  return HookInvocationSchema.parse({
    invocationId: input.invocationId,
    eventId: input.triggerEventId,
    runId: input.request.context.runId,
    threadId: input.request.context.threadId,
    handlerId: input.definition.handlerId,
    source: input.definition.source,
    order: input.definition.order,
    eventName: input.definition.eventName,
    startedAt: toTimestamp(input.startedAtMs),
    completedAt:
      input.completedAtMs === null ? null : toTimestamp(input.completedAtMs),
    status: input.status,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    errorCode: input.error?.code ?? null,
    errorMessage: input.error?.message ?? null,
  });
}

function parseRequest<EventName extends PrivateAlphaHookEventName>(
  eventName: EventName,
  request: HookRequestByEventName[EventName],
): HookRequestByEventName[EventName] {
  return HookRequestSchemaByEventName[eventName].parse(
    request,
  ) as HookRequestByEventName[EventName];
}

function parseOutcome<EventName extends PrivateAlphaHookEventName>(
  eventName: EventName,
  outcome: unknown,
): HookOutcomeByEventName[EventName] {
  return HookOutcomeSchemaByEventName[eventName].parse(
    outcome,
  ) as HookOutcomeByEventName[EventName];
}

function summarizeOutcome<EventName extends PrivateAlphaHookEventName>(
  eventName: EventName,
  outcome: HookOutcomeByEventName[EventName],
): HookOutcomeSummary {
  const base = {
    eventName,
    status: outcome.status,
    hasUserVisibleMessage: outcome.userVisibleMessage !== null,
    addedContextCount: outcome.modelContextAdditions.length,
  };
  if (eventName === "Stop") {
    const stopOutcome = outcome as HookOutcomeByEventName["Stop"];
    return {
      ...base,
      eventName,
      status: "continue",
      cleanupStatus: stopOutcome.cleanupResult?.status ?? null,
    };
  }
  return { ...base, cleanupStatus: null } as HookOutcomeSummary;
}

interface WaitForExecutionInput {
  execute: () => Promise<unknown>;
  controller: AbortController;
  parentSignal: AbortSignal | undefined;
  timeoutMs: number;
}

async function waitForExecution(input: WaitForExecutionInput): Promise<unknown> {
  if (input.parentSignal?.aborted) throw new HookCancelledError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachParentSignal: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    const onParentAbort = () => {
      input.controller.abort();
      reject(new HookCancelledError());
    };
    if (input.parentSignal) {
      input.parentSignal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () =>
        input.parentSignal?.removeEventListener("abort", onParentAbort);
    }
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      input.controller.abort();
      reject(new HookTimedOutError(input.timeoutMs));
    }, input.timeoutMs);
  });
  try {
    return await Promise.race([input.execute(), timeout, cancellation]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detachParentSignal?.();
  }
}

class HookTimedOutError extends Error {
  constructor(readonly timeoutMs: number) {
    super("Hook timed out.");
  }
}

class HookCancelledError extends Error {}

interface HookFailure {
  status: "failed" | "timed_out" | "cancelled";
  code: string;
  message: string;
}

function toSafeFailure(error: unknown): HookFailure {
  if (error instanceof HookTimedOutError) {
    return {
      status: "timed_out",
      code: "HOOK_TIMED_OUT",
      message: `Hook exceeded its ${error.timeoutMs} ms limit.`,
    };
  }
  if (error instanceof HookCancelledError) {
    return {
      status: "cancelled",
      code: "HOOK_CANCELLED",
      message: "Hook execution was cancelled.",
    };
  }
  if (isSchemaError(error)) {
    return {
      status: "failed",
      code: "HOOK_OUTCOME_INVALID",
      message: "Hook returned an invalid outcome.",
    };
  }
  return {
    status: "failed",
    code: "HOOK_EXECUTION_FAILED",
    message: "Hook handler failed.",
  };
}

function isSchemaError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ZodError"
  );
}

function toCleanupReason(
  failure: HookFailure | null,
): HookExecutionCleanupReason {
  return failure?.status ?? "completed";
}

function toAuditEventType(
  status: HookFailure["status"],
): HookAuditEventType {
  switch (status) {
    case "failed":
      return "hook.invocation.failed";
    case "timed_out":
      return "hook.invocation.timed_out";
    case "cancelled":
      return "hook.invocation.cancelled";
  }
}

function toTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
