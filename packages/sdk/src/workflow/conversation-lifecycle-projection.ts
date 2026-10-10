import type { HookInvocationAuditEvent } from "@repo/hook-protocol";
import type { ItemKind, LifecycleEvent, TurnDiffPayload, TurnId } from "@repo/platform-protocol";
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
}

export function createLifecycleProjection(
  turnId: TurnId,
): LifecycleProjection {
  return {
    ...createTurnWorkflowProjection(turnId),
    hookAudits: createHookAuditProjection().events,
  };
}

export function applyConversationLifecycleEvent(
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
  return events.reduce(applyConversationLifecycleEvent, createLifecycleProjection(turnId));
}

export { workflowPhaseLabel as lifecyclePhaseLabel };
export type { HookInvocationAuditEvent, ItemKind, TurnDiffPayload };
