import type {
  HookInvocationAuditEvent,
  ItemKind,
  LifecycleEvent,
  TurnDiffPayload,
  TurnId,
} from "../api/lifecycleClient";
import {
  applyHookAuditLifecycleEvent,
  createHookAuditProjection,
} from "../api/lifecycleClient";
import {
  applyLifecycleEvent as applySdkLifecycleEvent,
  createTurnWorkflowProjection,
  workflowPhaseLabel,
  type TurnWorkflowProjection,
} from "@repo/platform-client-sdk";

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
}

export function createLifecycleProjection(
  turnId: TurnId,
): LifecycleProjection {
  return {
    ...createTurnWorkflowProjection(turnId),
    hookAudits: createHookAuditProjection().events,
  };
}

export function applyLifecycleEvent(
  projection: LifecycleProjection,
  event: LifecycleEvent,
): LifecycleProjection {
  if (event.turnId !== projection.turnId) return projection;
  return {
    ...applySdkLifecycleEvent(projection, event),
    hookAudits: applyHookAuditLifecycleEvent(
      { events: projection.hookAudits },
      event,
    ).events,
  };
}

export function replayLifecycleProjection(
  turnId: TurnId,
  events: readonly LifecycleEvent[],
): LifecycleProjection {
  return events.reduce(applyLifecycleEvent, createLifecycleProjection(turnId));
}

export { workflowPhaseLabel as lifecyclePhaseLabel };
export type { HookInvocationAuditEvent, ItemKind, TurnDiffPayload };
