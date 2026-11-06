import { useEffect, useRef, useState } from "react";
import type {
  HarnessClient,
  HarnessInstanceStatus,
  HarnessModelsResponse,
  HarnessStatusRequest,
} from "@legioncode/sdk";

import {
  HarnessConnectionSetup,
  type HarnessConnectionSetupProps,
} from "./HarnessConnectionSetup.js";

export interface HarnessConnectionSettingsProps {
  client: HarnessClient;
  scope: HarnessStatusRequest;
  loadSetupConnections?: HarnessConnectionSetupProps["loadConnections"];
  onConnectionSetup?: (instance: HarnessInstanceStatus) => void;
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
  loadSetupConnections,
  onConnectionSetup,
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
      const result = await client.setup({
        workspaceId: instance.workspaceId,
        environmentId: instance.environmentId,
        instanceId: instance.instanceId,
        harness: instance.harness,
        connectionId: instance.connectionId,
        clientCommandId: crypto.randomUUID(),
      });
      if (
        result.instance.instanceId !== instance.instanceId ||
        result.instance.workspaceId !== workspaceId ||
        result.instance.environmentId !== environmentId ||
        result.instance.harness !== instance.harness ||
        (result.instance.connectionId !== null &&
          result.instance.connectionId !== instance.connectionId)
      ) {
        throw new Error(
          "Reconnect returned a different instance or connection",
        );
      }
      if (mounted.current) {
        setRefresh((value) => value + 1);
        onConnectionSetup?.(result.instance);
      }
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
      {loadSetupConnections ? (
        <HarnessConnectionSetup
          client={client}
          scope={scope}
          loadConnections={loadSetupConnections}
          onSetup={(instance) => {
            setInstances((current) => [
              ...current.filter(
                (item) => item.instanceId !== instance.instanceId,
              ),
              instance,
            ]);
            setRefresh((value) => value + 1);
            onConnectionSetup?.(instance);
          }}
        />
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
          {instance.connectionId && instance.state === "ready" ? (
            <ConnectionModels
              key={instance.connectionId + instance.observedAt}
              client={client}
              instance={instance}
            />
          ) : null}
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

/** Model discovery is scoped to a connection, independent of any conversation. */
function ConnectionModels({
  client,
  instance,
}: {
  client: HarnessClient;
  instance: HarnessInstanceStatus;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<HarnessModelsResponse | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open || !instance.connectionId) return;
    let active = true;
    setResult(null);
    setError(false);
    void client
      .models({
        workspaceId: instance.workspaceId,
        environmentId: instance.environmentId,
        instanceId: instance.instanceId,
        connectionId: instance.connectionId,
      })
      .then((models) => {
        if (!active) return;
        if (
          models.workspaceId !== instance.workspaceId ||
          models.environmentId !== instance.environmentId ||
          models.instanceId !== instance.instanceId ||
          models.connectionId !== instance.connectionId
        ) {
          setError(true);
          return;
        }
        setResult(models);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [client, instance, open, refresh]);
  return (
    <div className="mt-2 text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide models" : "Show models"}
      </button>
      {open ? (
        <>
          {error ? (
            <p role="alert">
              Models could not be loaded.{" "}
              <button
                type="button"
                onClick={() => setRefresh((value) => value + 1)}
              >
                Retry
              </button>
            </p>
          ) : !result ? (
            <p role="status">Loading models…</p>
          ) : result.availability !== "available" ? (
            <p role="status">
              {result.reason ?? "Models are unavailable for this connection."}
            </p>
          ) : result.models.length === 0 ? (
            <p role="status">No models are available for this connection.</p>
          ) : (
            <ul>
              {result.models.map((model) => (
                <li key={model.id}>{model.label}</li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
