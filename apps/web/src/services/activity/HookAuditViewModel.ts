import type { HookInvocationAuditEvent } from "@repo/hook-protocol";

export type HookAuditTone = "running" | "completed" | "failed" | "muted";

export interface HookAuditDisclosureViewModel {
  key: string;
  label: string;
  statusLabel: string;
  tone: HookAuditTone;
  sourceLabel: string;
  eventLabel: string;
  handlerLabel: string;
  durationLabel: string | null;
  outcomeLabel: string | null;
  failure: {
    code: string;
    message: string;
  } | null;
}

/**
 * Maps an already-validated, server-owned hook audit event to presentation
 * data. It intentionally excludes hashes and hook payloads: neither is useful
 * in chat, and exposing them risks leaking private context or hidden output.
 */
export function buildHookAuditDisclosureViewModel(
  event: HookInvocationAuditEvent,
): HookAuditDisclosureViewModel {
  const { invocation } = event;
  const failure =
    invocation.errorCode !== null && invocation.errorMessage !== null
      ? { code: invocation.errorCode, message: invocation.errorMessage }
      : null;

  return {
    key: event.auditEventId,
    label: hookActivityLabel(invocation.eventName, invocation.status),
    statusLabel: hookStatusLabel(invocation.status),
    tone: hookTone(invocation.status),
    sourceLabel: humanizeIdentifier(invocation.source),
    eventLabel: humanizeEventName(invocation.eventName),
    handlerLabel: invocation.handlerId,
    durationLabel: formatDuration(event.metadata.durationMs),
    outcomeLabel: event.outcomeSummary
      ? `Outcome: ${event.outcomeSummary.status}`
      : null,
    failure,
  };
}

function hookActivityLabel(
  eventName: HookInvocationAuditEvent["invocation"]["eventName"],
  status: HookInvocationAuditEvent["invocation"]["status"],
): string {
  const eventLabel = humanizeEventName(eventName);
  if (status === "failed" || status === "timed_out" || status === "cancelled") {
    return `${eventLabel} hook failed`;
  }
  if (status === "running" || status === "queued") {
    return `Running ${eventLabel} hook`;
  }
  if (status === "skipped") {
    return `${eventLabel} hook skipped`;
  }
  return `Ran ${eventLabel} hook`;
}

function hookStatusLabel(
  status: HookInvocationAuditEvent["invocation"]["status"],
): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "timed_out":
      return "Timed out";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "cancelled":
      return "Cancelled";
  }
}

function hookTone(
  status: HookInvocationAuditEvent["invocation"]["status"],
): HookAuditTone {
  if (status === "running" || status === "queued") {
    return "running";
  }
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed" || status === "timed_out") {
    return "failed";
  }
  return "muted";
}

function humanizeEventName(
  eventName: HookInvocationAuditEvent["invocation"]["eventName"],
): string {
  return eventName.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function humanizeIdentifier(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) {
    return null;
  }
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
