import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, RotateCw, ShieldCheck, Trash2 } from "lucide-react";
import type { HookSettingsAuditReadModel } from "../../services/api/lifecycleClient.js";
import {
  createHookDefinitionsClient,
  type HookDefinitionsClient,
  type HookDefinition,
} from "../../services/api/hookDefinitionsClient.js";
import { buildHookSettingsViewModel } from "../../services/settings/HookSettingsViewModel.js";

interface HooksSettingsPanelProps {
  readonly isActive: boolean;
  readonly workspaceId?: string | null;
  readonly audits?: readonly HookSettingsAuditReadModel[];
  readonly client?: HookDefinitionsClient;
}

type LoadState = "idle" | "loading" | "ready" | "error";

/**
 * Settings is a client of the server-owned definition repository. It never
 * discovers, runs, or persists hooks locally; runtime audit events are passed
 * in as a read-only projection from the active canonical turn.
 */
export function HooksSettingsPanel({
  isActive,
  workspaceId = null,
  audits = [],
  client,
}: HooksSettingsPanelProps): React.ReactElement {
  const defaultClient = useMemo(() => createHookDefinitionsClient(), []);
  const hookClient = client ?? defaultClient;
  const [definitions, setDefinitions] = useState<HookDefinition[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [savingHandlerId, setSavingHandlerId] = useState<string | null>(null);
  const [pendingRemovalHandlerId, setPendingRemovalHandlerId] = useState<
    string | null
  >(null);

  const loadDefinitions = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!workspaceId) {
        setDefinitions([]);
        setLoadState("idle");
        return;
      }

      setLoadState("loading");
      setError(null);
      try {
        const nextDefinitions = await hookClient.list(workspaceId, signal);
        if (!signal?.aborted) {
          setDefinitions(nextDefinitions);
          setLoadState("ready");
        }
      } catch (caught) {
        if (signal?.aborted) return;
        setLoadState("error");
        setError(safeMessage(caught));
      }
    },
    [hookClient, workspaceId],
  );

  useEffect(() => {
    if (!isActive) return;
    const controller = new AbortController();
    void loadDefinitions(controller.signal);
    return () => controller.abort();
  }, [isActive, loadDefinitions]);

  const groups = useMemo(
    () => buildHookSettingsViewModel({ definitions, audits }),
    [audits, definitions],
  );

  const updateEnabled = useCallback(
    async (handlerId: string): Promise<void> => {
      if (!workspaceId) return;
      const current = definitions.find(
        (definition) => definition.handlerId === handlerId,
      );
      if (!current || current.source !== "user") return;

      setSavingHandlerId(handlerId);
      setError(null);
      try {
        const updated = await hookClient.update(workspaceId, {
          ...current,
          enabled: !current.enabled,
        });
        setDefinitions((previous) =>
          previous.map((definition) =>
            definition.handlerId === updated.handlerId ? updated : definition,
          ),
        );
      } catch (caught) {
        setError(safeMessage(caught));
      } finally {
        setSavingHandlerId(null);
      }
    },
    [definitions, hookClient, workspaceId],
  );

  const removeDefinition = useCallback(
    async (handlerId: string): Promise<void> => {
      if (!workspaceId) return;
      const current = definitions.find(
        (definition) => definition.handlerId === handlerId,
      );
      if (!current || current.source !== "user") return;

      setSavingHandlerId(handlerId);
      setError(null);
      try {
        await hookClient.delete(workspaceId, handlerId);
        setDefinitions((previous) =>
          previous.filter((definition) => definition.handlerId !== handlerId),
        );
        setPendingRemovalHandlerId(null);
      } catch (caught) {
        setError(safeMessage(caught));
      } finally {
        setSavingHandlerId(null);
      }
    },
    [definitions, hookClient, workspaceId],
  );

  if (!workspaceId) {
    return (
      <SettingsNotice>
        Open a task with a server-owned workspace before managing its hooks.
      </SettingsNotice>
    );
  }

  return (
    <div className="space-y-5">
      <div className="ui-surface-section px-5 py-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 shrink-0 text-zinc-400" size={18} />
          <div>
            <h3 className="text-base font-medium text-zinc-100">
              Lifecycle hooks
            </h3>
            <p className="mt-1 text-sm leading-6 text-zinc-400">
              Hooks are configured by the server and run only within the
              canonical task lifecycle. This view cannot run hooks or change
              project and plugin definitions.
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-900/70 bg-red-950/25 px-4 py-3 text-sm text-red-200"
        >
          {error}
        </div>
      ) : null}

      {loadState === "loading" ? (
        <SettingsNotice>
          <LoaderCircle className="animate-spin" size={16} /> Loading hooks…
        </SettingsNotice>
      ) : null}

      {loadState === "error" ? (
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
          onClick={() => void loadDefinitions()}
        >
          <RotateCw size={15} /> Retry
        </button>
      ) : null}

      {loadState === "ready" && groups.length === 0 ? (
        <SettingsNotice>
          No server-owned hook definitions are configured for this workspace.
        </SettingsNotice>
      ) : null}

      {groups.map((group) => (
        <section key={group.eventName} aria-labelledby={`hook-event-${group.eventName}`}>
          <h3
            id={`hook-event-${group.eventName}`}
            className="mb-2 text-sm font-medium text-zinc-300"
          >
            {group.label}
          </h3>
          <div className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/30">
            {group.rows.map((row) => {
              const isSaving = savingHandlerId === row.handlerId;
              const confirmRemoval = pendingRemovalHandlerId === row.handlerId;
              return (
                <div key={row.key} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-zinc-100">
                          {row.displayName}
                        </p>
                        <span className="rounded-md border border-zinc-700 px-1.5 py-0.5 text-[11px] font-medium text-zinc-400">
                          {row.sourceLabel}
                        </span>
                        <StatusPill tone={row.statusTone} label={row.statusLabel} />
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">
                        {row.observedLabel}
                        {row.durationLabel ? ` · ${row.durationLabel}` : ""}
                      </p>
                      {row.configurationLabel ? (
                        <p className="mt-1 text-xs text-zinc-500">
                          {row.configurationLabel}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={row.enabled}
                        aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.displayName}`}
                        disabled={!row.canEdit || isSaving}
                        title={
                          row.canEdit
                            ? "Toggle this personal hook"
                            : "Managed by its project or plugin source"
                        }
                        onClick={() => void updateEnabled(row.handlerId)}
                        className={`relative h-6 w-10 rounded-full transition disabled:cursor-not-allowed disabled:opacity-45 ${
                          row.enabled ? "bg-zinc-200" : "bg-zinc-700"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-5 w-5 rounded-full bg-zinc-950 shadow transition-transform ${
                            row.enabled ? "translate-x-4" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                      {row.canEdit ? (
                        confirmRemoval ? (
                          <>
                            <button
                              type="button"
                              disabled={isSaving}
                              onClick={() => void removeDefinition(row.handlerId)}
                              className="rounded-md border border-red-900/80 px-2 py-1 text-xs font-medium text-red-200 transition hover:border-red-700 hover:bg-red-950/40 disabled:opacity-50"
                            >
                              Confirm remove
                            </button>
                            <button
                              type="button"
                              disabled={isSaving}
                              onClick={() => setPendingRemovalHandlerId(null)}
                              className="rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={isSaving}
                            aria-label={`Remove ${row.displayName}`}
                            onClick={() => setPendingRemovalHandlerId(row.handlerId)}
                            className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
                          >
                            <Trash2 size={15} />
                          </button>
                        )
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function SettingsNotice({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/30 px-4 py-3 text-sm text-zinc-400">
      {children}
    </div>
  );
}

function StatusPill({
  tone,
  label,
}: {
  tone: "muted" | "running" | "success" | "failure";
  label: string;
}): React.ReactElement {
  const toneClass =
    tone === "running"
      ? "border-blue-900/80 bg-blue-950/30 text-blue-200"
      : tone === "success"
        ? "border-emerald-900/70 bg-emerald-950/25 text-emerald-200"
        : tone === "failure"
          ? "border-red-900/70 bg-red-950/25 text-red-200"
          : "border-zinc-700 text-zinc-400";
  return (
    <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${toneClass}`}>
      {label}
    </span>
  );
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Hook settings could not be updated. Try again.";
}
