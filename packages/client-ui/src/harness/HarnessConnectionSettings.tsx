import { useEffect, useRef, useState } from "react";
import type {
  HarnessClient,
  HarnessInstanceStatus,
  HarnessStatusRequest,
} from "@legioncode/sdk";

export interface HarnessConnectionSettingsProps {
  client: HarnessClient;
  scope: HarnessStatusRequest;
}

/** Display-safe host status only. Authentication and installation stay with the host. */
export function HarnessConnectionSettings(
  props: HarnessConnectionSettingsProps,
) {
  return (
    <HarnessConnectionSettingsContent
      key={JSON.stringify(props.scope)}
      {...props}
    />
  );
}

function HarnessConnectionSettingsContent({
  client,
  scope,
}: HarnessConnectionSettingsProps) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [instances, setInstances] = useState<HarnessInstanceStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);
  const { workspaceId, environmentId } = scope;

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    setInstances([]);
    void client
      .status({ workspaceId, environmentId })
      .then((result) => {
        if (active)
          setInstances(
            result.instances.filter(
              (instance) =>
                instance.workspaceId === workspaceId &&
                instance.environmentId === environmentId,
            ),
          );
      })
      .catch(() => {
        if (active)
          setError(
            "Agent connections could not be loaded. Refresh to try again.",
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, environmentId, refresh]);

  async function reconnect(instance: HarnessInstanceStatus) {
    if (!instance.connectionId) return;
    setRetrying(instance.instanceId);
    setError(null);
    try {
      await client.setup({
        workspaceId: instance.workspaceId,
        environmentId: instance.environmentId,
        instanceId: instance.instanceId,
        harness: instance.harness,
        connectionId: instance.connectionId,
        clientCommandId: crypto.randomUUID(),
      });
      if (mounted.current) setRefresh((value) => value + 1);
    } catch {
      if (mounted.current)
        setError(
          "Agent setup could not be completed. Check the connection on its host, then refresh.",
        );
    } finally {
      if (mounted.current) setRetrying(null);
    }
  }

  return (
    <section aria-label="Agent connections" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Agent connections</h3>
        <button
          type="button"
          disabled={busy || retrying !== null}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh
        </button>
      </div>
      <p className="text-sm text-zinc-400">
        Connections apply only to this environment.
      </p>
      {busy ? <p role="status">Loading agent connections…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!busy && !error && instances.length === 0 ? (
        <p>No agents are connected in this environment.</p>
      ) : null}
      {instances.map((instance) => (
        <div
          key={instance.instanceId}
          className="rounded-lg border border-zinc-700 p-3"
        >
          <p>
            {instance.harness} ·{" "}
            {instance.accountLabel ?? "Account unavailable"}
          </p>
          <p role="status">
            {instance.state.replaceAll("_", " ")}
            {instance.capabilities.experimental ? " · Experimental" : ""}
          </p>
          {instance.reason ? (
            <p className="text-sm text-zinc-400">{instance.reason}</p>
          ) : null}
          <p className="text-xs text-zinc-400">
            Last checked{" "}
            <time dateTime={instance.observedAt}>
              {new Date(instance.observedAt).toLocaleString()}
            </time>
          </p>
          {instance.connectionId &&
          (instance.state === "offline" ||
            instance.state === "reauthentication_required") ? (
            <button
              type="button"
              disabled={busy || retrying !== null}
              onClick={() => void reconnect(instance)}
            >
              {retrying === instance.instanceId ? "Connecting…" : "Reconnect"}
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}
