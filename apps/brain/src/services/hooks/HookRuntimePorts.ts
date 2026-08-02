import type {
  HookAuditAppendInput,
  HookDefinition,
  HookInvocationId,
  HookOutcomeByEventName,
  HookRequestByEventName,
  HookRuntimeContext,
  PrivateAlphaHookEventName,
} from "@repo/hook-protocol";

export interface HookExecutionInput<
  EventName extends PrivateAlphaHookEventName,
> {
  definition: HookDefinition & { eventName: EventName };
  request: HookRequestByEventName[EventName];
  signal: AbortSignal;
}

export type HookExecutionCleanupReason =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface HookExecutionCleanupInput {
  definition: HookDefinition;
  invocationId: HookInvocationId;
  reason: HookExecutionCleanupReason;
  signal: AbortSignal;
}

/**
 * Trusted execution adapter. Shell/script execution is intentionally absent.
 * Implementations must stop work and release resources when `signal` aborts;
 * the runner cannot make an adapter that ignores cancellation safe.
 */
export interface HookExecutorPort {
  execute<EventName extends PrivateAlphaHookEventName>(
    input: HookExecutionInput<EventName>,
  ): Promise<unknown>;
  cleanup(input: HookExecutionCleanupInput): Promise<void>;
}

/** Verifies that task identity came from the authenticated control plane. */
export interface HookScopeAuthorizer {
  assertAuthorized(context: HookRuntimeContext): Promise<void>;
}

/** The adapter owns durable IDs/sequences and appends through lifecycle truth. */
export interface HookAuditSink {
  append(input: HookAuditAppendInput): Promise<void>;
}

export interface HookPayloadDigester {
  digest(value: unknown): Promise<string>;
}

export interface HookInvocationIdFactory {
  next(): HookInvocationId;
}

export interface HookClock {
  nowMs(): number;
}

export type HookHandlerRunResult<EventName extends PrivateAlphaHookEventName> =
  | {
      definition: HookDefinition;
      invocationId: HookInvocationId;
      status: "completed";
      outcome: HookOutcomeByEventName[EventName];
      error: null;
    }
  | {
      definition: HookDefinition;
      invocationId: HookInvocationId;
      status: "failed" | "timed_out" | "cancelled";
      outcome: null;
      error: { code: string; message: string };
    };

export interface HookRunResult<EventName extends PrivateAlphaHookEventName> {
  eventName: EventName;
  handlers: readonly HookHandlerRunResult<EventName>[];
}
