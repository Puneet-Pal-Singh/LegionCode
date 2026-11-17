import { useEffect, useState } from "react";
import {
  HarnessKindSchema,
  HarnessSetupRequestSchema,
  type HarnessKind,
  type HarnessStatusRequest,
} from "@repo/platform-protocol";

export type HarnessConnectionPlacement = "local" | "cloud";

export interface HarnessConnectionOption {
  connectionId: string;
  label: string;
  provider: string;
  authKind: "api_key" | "oauth" | "external";
}

export type HarnessConnectionQuery = HarnessStatusRequest & {
  placement: HarnessConnectionPlacement;
  harness: HarnessKind;
};

/** Returns only eligible, display-safe connections for the exact requested scope. */
export type HarnessConnectionLoader = (
  query: HarnessConnectionQuery,
) => Promise<{
  scope: HarnessConnectionQuery;
  connections: readonly HarnessConnectionOption[];
}>;

export const harnessLabels: Record<HarnessKind, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude Agent",
};

const authLabels: Record<HarnessConnectionOption["authKind"], string> = {
  api_key: "API key",
  oauth: "OAuth",
  external: "Provider-managed",
};

export const harnessControlClass =
  "rounded-md border border-[var(--lc-color-border-subtle)] bg-[var(--lc-color-surface)] px-2 py-1 text-[var(--lc-color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--lc-color-accent)] disabled:opacity-50";

type ConnectionChoice = { harness: HarnessKind; connectionId: string };

interface Props {
  scope: HarnessStatusRequest;
  placement: HarnessConnectionPlacement;
  loadConnections: HarnessConnectionLoader;
  refresh: number;
  active: boolean;
  created: number;
  locked: boolean;
  onConfigure: (choice: ConnectionChoice) => void;
}

export function HarnessConnectionSetup({
  scope,
  placement,
  loadConnections,
  refresh,
  active,
  created,
  locked,
  onConfigure,
}: Props) {
  const [harness, setHarness] = useState<HarnessKind | "">("");
  const [selected, setSelected] = useState<ConnectionChoice | null>(null);
  const [loaded, setLoaded] = useState<{
    loader: HarnessConnectionLoader;
    harness: HarnessKind;
    refresh: number;
    connections: readonly HarnessConnectionOption[] | null;
  } | null>(null);
  const { workspaceId, environmentId } = scope;

  useEffect(() => {
    setSelected(null);
  }, [created]);

  useEffect(() => {
    if (!active || !harness) return;
    let current = true;
    const query = { workspaceId, environmentId, placement, harness };

    async function load() {
      let connections: readonly HarnessConnectionOption[] | null = null;
      try {
        const result = await loadConnections(query);
        if (
          result.scope.workspaceId === workspaceId &&
          result.scope.environmentId === environmentId &&
          result.scope.placement === placement &&
          result.scope.harness === harness
        ) {
          const ids = new Set<string>();
          connections = result.connections;
          for (const option of connections) {
            const request =
              HarnessSetupRequestSchema.shape.connectionId.safeParse(
                option.connectionId,
              );
            if (
              !request.success ||
              request.data !== option.connectionId ||
              ids.has(option.connectionId) ||
              !option.label.trim() ||
              !option.provider.trim() ||
              !Object.hasOwn(authLabels, option.authKind)
            ) {
              connections = null;
              break;
            }
            ids.add(option.connectionId);
          }
        }
      } catch {
        connections = null;
      }
      if (current && harness)
        setLoaded({ loader: loadConnections, harness, refresh, connections });
    }

    void load();
    return () => {
      current = false;
    };
  }, [
    workspaceId,
    environmentId,
    placement,
    harness,
    loadConnections,
    refresh,
    active,
  ]);

  const result =
    loaded?.harness === harness &&
    loaded.loader === loadConnections &&
    loaded.refresh === refresh
      ? loaded
      : null;
  const choices = result?.connections ?? [];
  const selection =
    selected?.harness === harness &&
    choices.some((option) => option.connectionId === selected.connectionId)
      ? selected
      : null;

  return (
    <div className="grid gap-2 rounded-lg border border-[var(--lc-color-border-subtle)] p-3">
      <h4 className="font-medium">Configure an agent</h4>
      <label className="grid gap-1">
        Harness
        <select
          className={harnessControlClass}
          disabled={locked}
          value={harness}
          onChange={(event) => {
            setHarness(
              HarnessKindSchema.safeParse(event.target.value).data ?? "",
            );
            setLoaded(null);
            setSelected(null);
          }}
        >
          <option value="">Choose a harness</option>
          <option value="codex">{harnessLabels.codex}</option>
          <option value="opencode">{harnessLabels.opencode}</option>
          <option value="claude">{harnessLabels.claude}</option>
        </select>
      </label>
      {harness && !result ? (
        <p role="status">Loading saved connections…</p>
      ) : null}
      {result?.connections === null ? (
        <p role="alert">
          Saved connections could not be loaded. Refresh to try again.
        </p>
      ) : null}
      {result?.connections?.length === 0 ? (
        <p>No eligible saved connections for this harness.</p>
      ) : null}
      {choices.length > 0 ? (
        <label className="grid gap-1">
          Saved connection
          <select
            className={harnessControlClass}
            disabled={locked}
            value={selection?.connectionId ?? ""}
            onChange={(event) => {
              setSelected(
                harness && event.target.value
                  ? { harness, connectionId: event.target.value }
                  : null,
              );
            }}
          >
            <option value="">Choose a saved connection</option>
            {choices.map((option) => (
              <option key={option.connectionId} value={option.connectionId}>
                {option.label} · {option.provider} ·{" "}
                {authLabels[option.authKind]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        type="button"
        className={`${harnessControlClass} justify-self-start`}
        disabled={locked || !selection}
        onClick={() => {
          if (selection) onConfigure(selection);
        }}
      >
        Save configuration
      </button>
    </div>
  );
}
