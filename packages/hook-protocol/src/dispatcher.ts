import { createHash, randomUUID } from "node:crypto";
import { EventIdSchema, type EventId } from "@repo/platform-protocol";
import { z } from "zod";
import {
  HookHandlerIdSchema,
  HookInvocationAuditEventSchema,
  HookInvocationIdSchema,
  type HookInvocation,
  type HookInvocationAuditEvent,
} from "./audit.js";
import { PrivateAlphaHookEventNameSchema } from "./events.js";
import {
  HookOutcomeSchemaByEventName,
  type HookOutcome,
  type HookOutcomeByEventName,
} from "./outcomes.js";
import {
  HookRequestSchemaByEventName,
  type HookRequestByEventName,
} from "./requests.js";

const DEFAULT_TIMEOUT_MS = 5_000;
type HookRequest = HookRequestByEventName[keyof HookRequestByEventName];
type AnyInternalHookHandler = (
  request: HookRequest,
  metadata: InternalHookHandlerRegistration,
) => Promise<HookOutcome>;

export const HookDispatcherFailurePolicySchema = z.enum([
  "continue",
  "stop_dispatch",
]);
export type HookDispatcherFailurePolicy = z.infer<
  typeof HookDispatcherFailurePolicySchema
>;

export const InternalHookHandlerRegistrationSchema = z
  .object({
    id: HookHandlerIdSchema,
    eventName: PrivateAlphaHookEventNameSchema,
    displayName: z.string().min(1).max(200),
    enabled: z.boolean(),
    order: z.number().int().safe(),
    timeoutMs: z.number().int().positive().max(30_000),
    failurePolicy: HookDispatcherFailurePolicySchema,
  })
  .strict();
export type InternalHookHandlerRegistration = z.infer<
  typeof InternalHookHandlerRegistrationSchema
>;

export type InternalHookHandler<
  TEventName extends keyof HookRequestByEventName,
> = (
  request: HookRequestByEventName[TEventName],
  metadata: InternalHookHandlerRegistration,
) => Promise<HookOutcomeByEventName[TEventName]>;

type StoredHandler = {
  sequence: number;
  registration: InternalHookHandlerRegistration;
  handler: AnyInternalHookHandler;
};

export type HookDispatchResult<
  TEventName extends keyof HookRequestByEventName,
> = {
  eventName: TEventName;
  outcomes: HookOutcomeByEventName[TEventName][];
  auditEvents: HookInvocationAuditEvent[];
};

type HookRunResult<TEventName extends keyof HookRequestByEventName> =
  | { status: "completed"; outcome: HookOutcomeByEventName[TEventName] }
  | { status: "failed"; error: Error }
  | { status: "timed_out"; error: Error };

export class HookDispatcher {
  private readonly handlers: StoredHandler[] = [];
  private sequence = 0;
  private auditSequence = 0;

  register<TEventName extends keyof HookRequestByEventName>(
    registration: InternalHookHandlerRegistration & { eventName: TEventName },
    handler: InternalHookHandler<TEventName>,
  ): void {
    const parsed = InternalHookHandlerRegistrationSchema.parse(registration);
    const wrapped = wrapHandler(handler);
    this.handlers.push({
      sequence: this.sequence,
      registration: parsed,
      handler: wrapped,
    });
    this.sequence += 1;
  }

  async dispatch<TEventName extends keyof HookRequestByEventName>(
    eventName: TEventName,
    request: HookRequestByEventName[TEventName],
  ): Promise<HookDispatchResult<TEventName>> {
    const parsedRequest = HookRequestSchemaByEventName[eventName].parse(
      request,
    ) as HookRequestByEventName[TEventName];
    const selected = this.selectHandlers(eventName);
    return this.runHandlers(eventName, parsedRequest, selected);
  }

  private selectHandlers<TEventName extends keyof HookRequestByEventName>(
    eventName: TEventName,
  ): StoredHandler[] {
    return this.handlers
      .filter((handler) => isEnabledHandlerFor(handler, eventName))
      .sort(compareHandlers);
  }

  private async runHandlers<TEventName extends keyof HookRequestByEventName>(
    eventName: TEventName,
    request: HookRequestByEventName[TEventName],
    handlers: StoredHandler[],
  ): Promise<HookDispatchResult<TEventName>> {
    const outcomes: HookOutcomeByEventName[TEventName][] = [];
    const auditEvents: HookInvocationAuditEvent[] = [];
    for (const registered of handlers) {
      const keepGoing = await this.runHandler(
        eventName,
        request,
        registered,
        outcomes,
        auditEvents,
      );
      if (!keepGoing) {
        break;
      }
    }
    return { eventName, outcomes, auditEvents };
  }

  private async runHandler<TEventName extends keyof HookRequestByEventName>(
    eventName: TEventName,
    request: HookRequestByEventName[TEventName],
    registered: StoredHandler,
    outcomes: HookOutcomeByEventName[TEventName][],
    auditEvents: HookInvocationAuditEvent[],
  ): Promise<boolean> {
    const invocation = createInvocation(eventName, request, registered);
    auditEvents.push(
      this.createAuditEvent("hook.invocation.started", invocation, null),
    );
    const result = await executeHandler(eventName, request, registered);
    applyRunResult(result, invocation, outcomes);
    auditEvents.push(this.auditForRunResult(invocation, result));
    if (result.status === "completed") {
      auditEvents.push(
        this.createAuditEvent(
          "hook.outcome.applied",
          invocation,
          result.outcome,
        ),
      );
    }
    return shouldContinue(result, registered.registration.failurePolicy);
  }

  private auditForRunResult<TEventName extends keyof HookRequestByEventName>(
    invocation: HookInvocation,
    result: HookRunResult<TEventName>,
  ): HookInvocationAuditEvent {
    if (result.status === "completed") {
      return this.createAuditEvent(
        "hook.invocation.completed",
        invocation,
        result.outcome,
      );
    }
    const eventType =
      result.status === "timed_out"
        ? "hook.invocation.timed_out"
        : "hook.invocation.failed";
    return this.createAuditEvent(eventType, invocation, null);
  }

  private createAuditEvent(
    eventType: HookInvocationAuditEvent["eventType"],
    invocation: HookInvocation,
    outcome: HookInvocationAuditEvent["outcome"],
  ): HookInvocationAuditEvent {
    const emittedAt = new Date().toISOString();
    const auditEvent = {
      auditEventId: `evt_${randomUUID().replaceAll("-", "")}`,
      eventType,
      invocation: { ...invocation },
      outcome,
      metadata: {},
      emittedAt,
      eventSequence: this.auditSequence,
    };
    this.auditSequence += 1;
    return HookInvocationAuditEventSchema.parse(auditEvent);
  }
}

function wrapHandler<TEventName extends keyof HookRequestByEventName>(
  handler: InternalHookHandler<TEventName>,
): AnyInternalHookHandler {
  return async (request, metadata) =>
    handler(
      request as HookRequestByEventName[TEventName],
      metadata,
    ) as Promise<HookOutcome>;
}

function isEnabledHandlerFor<TEventName extends keyof HookRequestByEventName>(
  handler: StoredHandler,
  eventName: TEventName,
): boolean {
  return (
    handler.registration.enabled && handler.registration.eventName === eventName
  );
}

function compareHandlers(left: StoredHandler, right: StoredHandler): number {
  return (
    left.registration.order - right.registration.order ||
    left.sequence - right.sequence ||
    left.registration.id.localeCompare(right.registration.id)
  );
}

function createInvocation<TEventName extends keyof HookRequestByEventName>(
  eventName: TEventName,
  request: HookRequestByEventName[TEventName],
  registered: StoredHandler,
): HookInvocation {
  const now = new Date().toISOString();
  return {
    invocationId: createInvocationId(),
    eventId: createEventId(),
    runId: request.context.runId,
    sessionId: request.context.sessionId,
    threadId: request.context.threadId,
    handlerId: registered.registration.id,
    eventName,
    startedAt: now,
    completedAt: null,
    status: "running",
    inputHash: hashJson(request),
    outputHash: null,
    errorCode: null,
    errorMessage: null,
  };
}

async function executeHandler<TEventName extends keyof HookRequestByEventName>(
  eventName: TEventName,
  request: HookRequestByEventName[TEventName],
  registered: StoredHandler,
): Promise<HookRunResult<TEventName>> {
  try {
    const outcome = await withTimeout(
      registered.handler(request, registered.registration),
      registered.registration.timeoutMs || DEFAULT_TIMEOUT_MS,
    );
    return parseOutcome(eventName, outcome);
  } catch (error) {
    return classifyError(error);
  }
}

function parseOutcome<TEventName extends keyof HookRequestByEventName>(
  eventName: TEventName,
  outcome: HookOutcome,
): HookRunResult<TEventName> {
  const parsed = HookOutcomeSchemaByEventName[eventName].parse(
    outcome,
  ) as HookOutcomeByEventName[TEventName];
  return { status: "completed", outcome: parsed };
}

function classifyError<TEventName extends keyof HookRequestByEventName>(
  error: unknown,
): HookRunResult<TEventName> {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (normalized.name === "HookTimeoutError") {
    return { status: "timed_out", error: normalized };
  }
  return { status: "failed", error: normalized };
}

function applyRunResult<TEventName extends keyof HookRequestByEventName>(
  result: HookRunResult<TEventName>,
  invocation: HookInvocation,
  outcomes: HookOutcomeByEventName[TEventName][],
): void {
  invocation.completedAt = new Date().toISOString();
  invocation.status =
    result.status === "completed" ? "completed" : result.status;
  if (result.status === "completed") {
    invocation.outputHash = hashJson(result.outcome);
    outcomes.push(result.outcome);
    return;
  }
  invocation.errorCode = result.status;
  invocation.errorMessage = result.error.message;
}

function shouldContinue<TEventName extends keyof HookRequestByEventName>(
  result: HookRunResult<TEventName>,
  failurePolicy: HookDispatcherFailurePolicy,
): boolean {
  return result.status === "completed" || failurePolicy === "continue";
}

function withTimeout<TValue>(
  promise: Promise<TValue>,
  timeoutMs: number,
): Promise<TValue> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`hook timed out after ${timeoutMs}ms`);
      error.name = "HookTimeoutError";
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createInvocationId(): z.infer<typeof HookInvocationIdSchema> {
  return HookInvocationIdSchema.parse(
    `hki_${randomUUID().replaceAll("-", "")}`,
  );
}

function createEventId(): EventId {
  return EventIdSchema.parse(`evt_${randomUUID().replaceAll("-", "")}`);
}
