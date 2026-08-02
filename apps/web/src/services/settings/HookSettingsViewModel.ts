import type { HookDefinition } from "../api/hookDefinitionsClient.js";
import type { HookSettingsAuditReadModel } from "../api/lifecycleClient.js";

export interface HookSettingsRowViewModel {
  readonly key: string;
  readonly handlerId: string;
  readonly displayName: string;
  readonly sourceLabel: string;
  readonly canEdit: boolean;
  readonly enabled: boolean;
  readonly statusLabel: string;
  readonly statusTone: "muted" | "running" | "success" | "failure";
  readonly observedLabel: string;
  readonly durationLabel: string | null;
  /** The API exposes an opaque lookup key, never a browser URL or a path. */
  readonly configurationLabel: string | null;
}

export interface HookSettingsGroupViewModel {
  readonly eventName: string;
  readonly label: string;
  readonly rows: readonly HookSettingsRowViewModel[];
}

export function buildHookSettingsViewModel(input: {
  definitions: readonly HookDefinition[];
  audits: readonly HookSettingsAuditReadModel[];
}): readonly HookSettingsGroupViewModel[] {
  const auditsByHook = new Map(
    input.audits.map((audit) => [auditKey(audit.handlerId, audit.source), audit]),
  );
  const groups = new Map<string, HookSettingsRowViewModel[]>();

  for (const definition of [...input.definitions].sort(compareDefinitions)) {
    const audit = auditsByHook.get(auditKey(definition.handlerId, definition.source));
    const row = toRow(definition, audit);
    const rows = groups.get(definition.eventName) ?? [];
    rows.push(row);
    groups.set(definition.eventName, rows);
  }

  return [...groups.entries()].map(([eventName, rows]) => ({
    eventName,
    label: eventLabel(eventName),
    rows,
  }));
}

function toRow(
  definition: HookDefinition,
  audit: HookSettingsAuditReadModel | undefined,
): HookSettingsRowViewModel {
  return {
    key: auditKey(definition.handlerId, definition.source),
    handlerId: definition.handlerId,
    displayName: definition.displayName,
    sourceLabel: sourceLabel(definition.source),
    canEdit: definition.source === "user",
    enabled: definition.enabled,
    statusLabel: audit ? statusLabel(audit.lastStatus) : "Not observed",
    statusTone: audit ? statusTone(audit.lastStatus) : "muted",
    observedLabel: audit ? observedLabel(audit.lastRunAt) : "No canonical audit yet",
    durationLabel: audit ? durationLabel(audit.lastDurationMs) : null,
    configurationLabel: safeConfigurationLabel(definition.configurationKey),
  };
}

function compareDefinitions(left: HookDefinition, right: HookDefinition): number {
  return (
    left.order - right.order ||
    left.displayName.localeCompare(right.displayName) ||
    left.handlerId.localeCompare(right.handlerId)
  );
}

function auditKey(handlerId: string, source: string): string {
  return `${source}:${handlerId}`;
}

function eventLabel(eventName: string): string {
  switch (eventName) {
    case "SessionStart":
      return "Session start";
    case "UserPromptSubmit":
      return "User prompt submit";
    case "PermissionRequest":
      return "Permission request";
    case "Stop":
      return "Stop";
    default:
      return eventName;
  }
}

function sourceLabel(source: HookDefinition["source"]): string {
  switch (source) {
    case "user":
      return "Personal";
    case "project":
      return "Project";
    case "plugin":
      return "Plugin";
    default:
      return "Managed";
  }
}

function statusLabel(status: HookSettingsAuditReadModel["lastStatus"]): string {
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

function statusTone(
  status: HookSettingsAuditReadModel["lastStatus"],
): HookSettingsRowViewModel["statusTone"] {
  if (status === "running" || status === "queued") return "running";
  if (status === "completed") return "success";
  if (status === "failed" || status === "timed_out") return "failure";
  return "muted";
}

function observedLabel(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "Observed by runtime";
  }
  return `Observed ${parsed.toISOString().replace("T", " ").replace(".000Z", " UTC")}`;
}

function durationLabel(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function safeConfigurationLabel(configurationKey: string | null): string | null {
  if (!configurationKey) return null;
  // Configuration keys are opaque server lookups. A URL/path is never created
  // from them because an untrusted key must not become browser navigation.
  return "Workspace configuration";
}
