import type { HookInvocationAuditEvent } from "@repo/hook-protocol";
import type { ItemKind, LifecycleEvent, NativeExecutionRecoveryProjection, TurnDiffPayload, TurnId } from "@repo/platform-protocol";
import { applyHookAuditLifecycleEvent, createHookAuditProjection } from "../platform/hook-audit-projection.js";
import { applyLifecycleEvent as applySdkLifecycleEvent, createTurnWorkflowProjection, workflowPhaseLabel, type TurnWorkflowProjection } from "./turn-workflow-projection.js";

export type LifecycleProjectionTerminalState = NonNullable<
  TurnWorkflowProjection["terminal"]
>["state"];
export type LifecycleProjectionPhase = TurnWorkflowProjection["phase"];
export type LifecycleProjectionItemStatus =
  TurnWorkflowProjection["items"][number]["status"];

export type LifecycleProjectionItem = TurnWorkflowProjection["items"][number];
export type LifecycleProjectionApproval =
  NonNullable<TurnWorkflowProjection["pendingApproval"]>;
export type LifecycleProjectionTerminal = NonNullable<
  TurnWorkflowProjection["terminal"]
>;

export interface LifecycleProjection extends TurnWorkflowProjection {
  readonly hookAudits: readonly HookInvocationAuditEvent[];
  /** Canonical accepted/applied input invalidation; carries no message body. */
  readonly inputSequence?: number;
  readonly recovery?: NativeExecutionRecoveryProjection | null;
  readonly runtimeAttempt?: Pick<LifecycleEvent, "threadId" | "runAttemptId">;
}

export function createLifecycleProjection(
  turnId: TurnId,
): LifecycleProjection {
  return {
    ...createTurnWorkflowProjection(turnId),
    hookAudits: createHookAuditProjection().events,
    inputSequence: 0,
  };
}

export function applyConversationLifecycleEvent(
  projection: LifecycleProjection,
  event: LifecycleEvent,
): LifecycleProjection {
  if (event.turnId !== projection.turnId) return projection;
  if (projection.recovery && (event.threadId !== projection.recovery.threadId || event.runAttemptId !== projection.recovery.runAttemptId)) return projection;
  const terminal = event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted";
  const next = applySdkLifecycleEvent(projection, event);
  return {
    ...next,
    activeThinking: projection.recovery && !terminal ? false : next.activeThinking,
    runtimeAttempt: projection.runtimeAttempt ?? { threadId: event.threadId, runAttemptId: event.runAttemptId },
    recovery: terminal ? null : projection.recovery,
    inputSequence: event.type === "turn.input.accepted" || event.type === "turn.input.applied"
      ? Math.max(projection.inputSequence ?? 0, event.sequence)
      : projection.inputSequence ?? 0,
    hookAudits: applyHookAuditLifecycleEvent(
      { events: projection.hookAudits },
      event,
    ).events,
  };
}

/** Absence on a later page never erases known recovery for this attempt. */
export function applyConversationLifecycleRecovery(
  projection: LifecycleProjection,
  recovery: NativeExecutionRecoveryProjection | undefined,
): LifecycleProjection {
  if (!recovery || recovery.turnId !== projection.turnId) return projection;
  const attempt = projection.runtimeAttempt;
  if (attempt && (attempt.threadId !== recovery.threadId || attempt.runAttemptId !== recovery.runAttemptId)) return projection;
  // A summary/legacy terminal with no captured attempt tuple cannot retire a
  // known recovery obligation. Only that attempt's canonical terminal wins.
  if (projection.terminal && attempt) return projection;
  if (projection.recovery && Object.keys(projection.recovery).some(key =>
      projection.recovery![key as keyof NativeExecutionRecoveryProjection] !== recovery[key as keyof NativeExecutionRecoveryProjection])) return projection;
  return { ...projection, recovery, activeThinking: false };
}

export function replayLifecycleProjection(
  turnId: TurnId,
  events: readonly LifecycleEvent[],
): LifecycleProjection {
  return events.reduce(applyConversationLifecycleEvent, createLifecycleProjection(turnId));
}

export { workflowPhaseLabel as lifecyclePhaseLabel };
export type { HookInvocationAuditEvent, ItemKind, TurnDiffPayload };
