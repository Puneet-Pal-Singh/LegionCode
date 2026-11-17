import type { Dispatch, SetStateAction } from "react";
import {
  Anchor,
  ChevronRight,
  LoaderCircle,
  RotateCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
export interface HookSettingsRow {
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
  readonly configurationLabel: string | null;
}
export interface HooksSettingsViewProps {
  workspaceAvailable?: boolean;
  unavailableReason?: string;
  sourceGroups?: readonly (readonly [string, readonly HookSettingsRow[]])[];
  groupCount?: number;
  loadState?: "idle" | "loading" | "ready" | "error";
  error?: string | null;
  savingHandlerId?: string | null;
  pendingRemovalHandlerId?: string | null;
  expandedSource?: string | null;
  onRefresh?: () => void | Promise<void>;
  onUpdateEnabled?: (handlerId: string) => void | Promise<void>;
  onRemoveDefinition?: (handlerId: string) => void | Promise<void>;
  setPendingRemovalHandlerId?: Dispatch<SetStateAction<string | null>>;
  setExpandedSource?: Dispatch<SetStateAction<string | null>>;
}
export function HooksSettingsView({
  workspaceAvailable = false,
  unavailableReason,
  sourceGroups = [],
  groupCount = 0,
  loadState = "idle",
  error = null,
  savingHandlerId = null,
  pendingRemovalHandlerId = null,
  expandedSource = null,
  onRefresh,
  onUpdateEnabled,
  onRemoveDefinition,
  setPendingRemovalHandlerId,
  setExpandedSource,
}: HooksSettingsViewProps): React.ReactElement {
  if (unavailableReason)
    return <SettingsNotice>{unavailableReason}</SettingsNotice>;
  if (!workspaceAvailable) {
    return (
      <SettingsNotice>
        Open a task with a server-owned workspace before managing its hooks.
      </SettingsNotice>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          Manage lifecycle hooks from your configuration and enabled plugins.
          Runtime audit status appears here after a hook is observed.
        </p>
        <button
          type="button"
          aria-label="Refresh hooks"
          onClick={() => void onRefresh?.()}
          className="rounded-lg p-2 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          <RotateCw size={16} aria-hidden="true" />
        </button>
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
          onClick={() => void onRefresh?.()}
        >
          <RotateCw size={15} /> Retry
        </button>
      ) : null}

      {loadState === "ready" && groupCount === 0 ? (
        <SettingsNotice>
          No server-owned hook definitions are configured for this workspace.
        </SettingsNotice>
      ) : null}

      {sourceGroups.length > 0 ? (
        <section className="space-y-3" aria-labelledby="hooks-from-config">
          <h3
            id="hooks-from-config"
            className="text-sm font-semibold text-zinc-300"
          >
            From config
          </h3>
          {sourceGroups.map(([source, rows]) => {
            const isExpanded = expandedSource === source;
            return (
              <div key={source} className="ui-surface-section overflow-hidden">
                <button
                  type="button"
                  onClick={() =>
                    setExpandedSource?.((current) =>
                      current === source ? null : source,
                    )
                  }
                  className="flex min-h-20 w-full items-center gap-4 px-5 text-left transition hover:bg-zinc-800/45"
                  aria-expanded={isExpanded}
                >
                  <ShieldCheck size={18} className="text-zinc-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-zinc-100">
                      {source === "Personal"
                        ? "User config"
                        : `${source} config`}
                    </span>
                    <span className="mt-1 block text-xs text-zinc-500">
                      {rows.length} {rows.length === 1 ? "hook" : "hooks"}
                    </span>
                  </span>
                  <ChevronRight
                    size={16}
                    className={`text-zinc-500 transition-transform ${
                      isExpanded ? "rotate-90" : ""
                    }`}
                  />
                </button>

                {isExpanded ? (
                  <div className="divide-y divide-zinc-800 border-t border-zinc-800/80">
                    {rows.map((row) => {
                      const isSaving = savingHandlerId === row.handlerId;
                      const confirmRemoval =
                        pendingRemovalHandlerId === row.handlerId;
                      return (
                        <div key={row.key} className="px-5 py-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex min-w-0 gap-3">
                              <Anchor
                                size={16}
                                className="mt-0.5 shrink-0 text-zinc-500"
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="font-medium text-zinc-100">
                                    {row.displayName}
                                  </p>
                                  <StatusPill
                                    tone={row.statusTone}
                                    label={row.statusLabel}
                                  />
                                </div>
                                <p className="mt-1 text-xs text-zinc-500">
                                  {row.observedLabel}
                                  {row.durationLabel
                                    ? ` · ${row.durationLabel}`
                                    : ""}
                                </p>
                                {row.configurationLabel ? (
                                  <p className="mt-1 text-xs text-zinc-500">
                                    {row.configurationLabel}
                                  </p>
                                ) : null}
                              </div>
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
                                onClick={() =>
                                  void onUpdateEnabled?.(row.handlerId)
                                }
                                className={`relative h-6 w-10 rounded-full transition disabled:cursor-not-allowed disabled:opacity-45 ${
                                  row.enabled ? "bg-zinc-200" : "bg-zinc-700"
                                }`}
                              >
                                <span
                                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-zinc-950 shadow transition-transform ${
                                    row.enabled
                                      ? "translate-x-4"
                                      : "translate-x-0.5"
                                  }`}
                                />
                              </button>
                              {row.canEdit ? (
                                confirmRemoval ? (
                                  <>
                                    <button
                                      type="button"
                                      disabled={isSaving}
                                      onClick={() =>
                                        void onRemoveDefinition?.(row.handlerId)
                                      }
                                      className="rounded-md border border-red-900/80 px-2 py-1 text-xs font-medium text-red-200 transition hover:border-red-700 hover:bg-red-950/40 disabled:opacity-50"
                                    >
                                      Confirm remove
                                    </button>
                                    <button
                                      type="button"
                                      disabled={isSaving}
                                      onClick={() =>
                                        setPendingRemovalHandlerId?.(null)
                                      }
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
                                    onClick={() =>
                                      setPendingRemovalHandlerId?.(
                                        row.handlerId,
                                      )
                                    }
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
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}

function SettingsNotice({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
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
    <span
      className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${toneClass}`}
    >
      {label}
    </span>
  );
}
