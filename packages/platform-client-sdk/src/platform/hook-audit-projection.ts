import {
  HookInvocationAuditEventSchema,
  HookInvocationLifecycleAuditSchema,
  type HookInvocationAuditEvent,
  type HookInvocationStatus,
} from "@repo/hook-protocol";
import type { LifecycleEvent } from "@repo/platform-protocol";

const HOOK_INVOCATION_EVENT_TYPES = new Set<LifecycleEvent["type"]>([
  "hook.invocation.started",
  "hook.invocation.completed",
  "hook.invocation.failed",
  "hook.invocation.timed_out",
  "hook.invocation.cancelled",
]);

export interface HookAuditProjectionState {
  readonly events: readonly HookInvocationAuditEvent[];
}

export interface HookSettingsAuditReadModel {
  readonly handlerId: string;
  readonly source: HookInvocationAuditEvent["invocation"]["source"];
  readonly eventName: HookInvocationAuditEvent["invocation"]["eventName"];
  readonly lastStatus: HookInvocationStatus;
  readonly lastRunAt: string;
  readonly lastDurationMs: number | null;
  readonly lastError: {
    readonly code: string;
    readonly message: string;
  } | null;
}

export class HookAuditProjectionError extends Error {
  readonly code = "invalid_hook_audit_lifecycle_event";

  constructor(message: string) {
    super(message);
    this.name = "HookAuditProjectionError";
  }
}

export function createHookAuditProjection(): HookAuditProjectionState {
  return { events: [] };
}

/**
 * Converts a canonical lifecycle envelope into the public, read-only hook
 * audit contract. Non-hook lifecycle events are ignored.
 */
export function projectHookAuditLifecycleEvent(
  event: LifecycleEvent,
): HookInvocationAuditEvent | null {
  if (!HOOK_INVOCATION_EVENT_TYPES.has(event.type)) {
    return null;
  }

  const parsed = HookInvocationLifecycleAuditSchema.safeParse(event.payload);
  if (
    !parsed.success ||
    parsed.data.eventType !== event.type ||
    parsed.data.invocation.threadId !== event.threadId
  ) {
    throw new HookAuditProjectionError(
      "The runtime returned an invalid hook audit event.",
    );
  }

  const auditEvent = HookInvocationAuditEventSchema.safeParse({
    ...parsed.data,
    auditEventId: event.eventId,
    eventSequence: event.sequence,
  });
  if (!auditEvent.success) {
    throw new HookAuditProjectionError(
      "The runtime returned an invalid hook audit event.",
    );
  }
  return auditEvent.data;
}

/**
 * Replay and live continuation use the same reducer. Each invocation occupies
 * one stable row: its terminal audit replaces the earlier running audit.
 */
export function applyHookAuditLifecycleEvent(
  state: HookAuditProjectionState,
  event: LifecycleEvent,
): HookAuditProjectionState {
  const audit = projectHookAuditLifecycleEvent(event);
  if (!audit) return state;

  const index = state.events.findIndex(
    (candidate) =>
      candidate.invocation.invocationId === audit.invocation.invocationId,
  );
  if (index === -1) {
    return { events: [...state.events, audit] };
  }
  const existing = state.events[index];
  if (!existing || existing.eventSequence >= audit.eventSequence) {
    return state;
  }
  if (
    existing.invocation.status !== "running" ||
    audit.invocation.status === "running"
  ) {
    throw new HookAuditProjectionError(
      "The runtime returned an invalid hook audit transition.",
    );
  }
  return {
    events: state.events.map((candidate, candidateIndex) =>
      candidateIndex === index ? audit : candidate,
    ),
  };
}

export function replayHookAuditLifecycleEvents(
  events: readonly LifecycleEvent[],
): HookAuditProjectionState {
  return events.reduce(
    applyHookAuditLifecycleEvent,
    createHookAuditProjection(),
  );
}

/**
 * Settings may show only observed server-owned audit state. Enablement and
 * configuration are deliberately absent because they require a separate
 * authenticated HookDefinition repository/API.
 */
export function buildHookSettingsAuditReadModel(
  state: HookAuditProjectionState,
): readonly HookSettingsAuditReadModel[] {
  const latestByHandler = new Map<string, HookInvocationAuditEvent>();
  for (const event of state.events) {
    const existing = latestByHandler.get(event.invocation.handlerId);
    if (!existing || existing.eventSequence < event.eventSequence) {
      latestByHandler.set(event.invocation.handlerId, event);
    }
  }

  return [...latestByHandler.values()]
    .sort((left, right) => left.eventSequence - right.eventSequence)
    .map((event) => ({
      handlerId: event.invocation.handlerId,
      source: event.invocation.source,
      eventName: event.invocation.eventName,
      lastStatus: event.invocation.status,
      lastRunAt: event.emittedAt,
      lastDurationMs: event.metadata.durationMs,
      lastError:
        event.invocation.errorCode && event.invocation.errorMessage
          ? {
              code: event.invocation.errorCode,
              message: event.invocation.errorMessage,
            }
          : null,
    }));
}
