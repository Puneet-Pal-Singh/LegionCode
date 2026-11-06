import { useEffect, useRef, useState } from "react";
import type {
  HarnessClient,
  HarnessInstanceStatus,
  HarnessModelsResponse,
  HarnessNextSelection,
  HarnessSelectionReadRequest,
  HarnessSelectionResponse,
} from "@legioncode/sdk";

export interface HarnessSelectionProps {
  client: HarnessClient;
  scope: HarnessSelectionReadRequest;
  onSelectionChange?: (selection: HarnessSelectionResponse) => void;
}

/** A server-backed preference for future attempts; never a handle to the active attempt. */
export function HarnessSelection(props: HarnessSelectionProps) {
  return (
    <HarnessSelectionContent key={JSON.stringify(props.scope)} {...props} />
  );
}

function HarnessSelectionContent({
  client,
  scope,
  onSelectionChange,
}: HarnessSelectionProps) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [snapshot, setSnapshot] = useState<HarnessSelectionResponse | null>(
    null,
  );
  const [instances, setInstances] = useState<HarnessInstanceStatus[]>([]);
  const [models, setModels] = useState<HarnessModelsResponse | null>(null);
  const [instanceId, setInstanceId] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const { workspaceId, environmentId, sessionId, threadId } = scope;

  useEffect(() => {
    let active = true;
    setBusy(true);
    setSnapshot(null);
    setInstances([]);
    setModels(null);
    setError(null);
    void Promise.all([
      client.readSelection({ workspaceId, environmentId, sessionId, threadId }),
      client.status({ workspaceId, environmentId }),
    ])
      .then(([selection, status]) => {
        if (!active) return;
        if (
          selection.workspaceId !== workspaceId ||
          selection.environmentId !== environmentId ||
          selection.sessionId !== sessionId ||
          selection.threadId !== threadId
        )
          throw new Error("Selection scope mismatch");
        setSnapshot(selection);
        setInstances(
          status.instances.filter(
            (item) =>
              item.workspaceId === workspaceId &&
              item.environmentId === environmentId,
          ),
        );
        setInstanceId(selection.selection?.instanceId ?? "");
      })
      .catch(() => {
        if (active)
          setError(
            "Agent selection could not be loaded. Refresh to try again.",
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, environmentId, sessionId, threadId, refresh]);

  const instance = instances.find((item) => item.instanceId === instanceId);
  useEffect(() => {
    let active = true;
    setModels(null);
    if (!instance?.connectionId || instance.state !== "ready") return;
    void client
      .models({
        workspaceId,
        environmentId,
        instanceId: instance.instanceId,
        connectionId: instance.connectionId,
      })
      .then((result) => {
        if (active) setModels(result);
      })
      .catch(() => {
        if (active)
          setError("Agent models could not be loaded. Refresh to try again.");
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, environmentId, instance, refresh]);

  async function select(modelId: string | null) {
    if (!snapshot) return;
    let selection: HarnessNextSelection | null = null;
    if (modelId !== null) {
      const model =
        availableModels?.availability === "available"
          ? availableModels.models.find((candidate) => candidate.id === modelId)
          : undefined;
      if (!instance?.connectionId || instance.state !== "ready" || !model)
        return;
      selection = {
        harness: instance.harness,
        instanceId: instance.instanceId,
        connectionId: instance.connectionId,
        modelId: model.id,
      };
    }
    setSaving(true);
    setError(null);
    try {
      const result = await client.select({
        ...scope,
        expectedRevision: snapshot.revision,
        clientCommandId: crypto.randomUUID(),
        selection,
      });
      if (!mounted.current) return;
      if (
        result.workspaceId !== workspaceId ||
        result.environmentId !== environmentId ||
        result.sessionId !== sessionId ||
        result.threadId !== threadId
      )
        throw new Error("Selection scope mismatch");
      setSnapshot(result);
      setInstanceId(result.selection?.instanceId ?? "");
      onSelectionChange?.(result);
    } catch {
      if (!mounted.current) return;
      setError(
        "Selection was not confirmed. Refresh before trying again; the active attempt is unchanged.",
      );
      setSnapshot(null);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const availableModels =
    models?.workspaceId === workspaceId &&
    models?.environmentId === environmentId &&
    models?.instanceId === instance?.instanceId &&
    models?.connectionId === instance?.connectionId
      ? models
      : null;
  const selectedModel =
    snapshot?.selection?.instanceId === instanceId
      ? snapshot.selection.modelId
      : "";
  return (
    <div className="space-y-2" aria-label="Agent for future attempts">
      <p className="text-xs text-zinc-400">
        Changes apply to future attempts in this environment.
      </p>
      {busy ? <p role="status">Loading agent selection…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        disabled={busy || saving}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh agents
      </button>
      {snapshot ? (
        <>
          <label>
            Agent account
            <select
              value={instanceId}
              disabled={busy || saving}
              onChange={(event) => setInstanceId(event.currentTarget.value)}
            >
              <option value="">Choose an agent account</option>
              {instanceId && !instance ? (
                <option value={instanceId} disabled>
                  Selected agent unavailable
                </option>
              ) : null}
              {instances.map((item) => (
                <option
                  key={item.instanceId}
                  value={item.instanceId}
                  disabled={item.state !== "ready" || !item.connectionId}
                >
                  {item.harness} · {item.accountLabel ?? "Account unavailable"}{" "}
                  · {item.state.replaceAll("_", " ")}
                  {item.capabilities.experimental ? " · Experimental" : ""}
                </option>
              ))}
            </select>
          </label>
          {availableModels?.availability === "available" ? (
            <label>
              Model
              <select
                value={selectedModel}
                disabled={saving}
                onChange={(event) => {
                  if (event.currentTarget.value)
                    void select(event.currentTarget.value);
                }}
              >
                <option value="">Choose a model</option>
                {selectedModel &&
                !availableModels.models.some(
                  (model) => model.id === selectedModel,
                ) ? (
                  <option value={selectedModel} disabled>
                    Selected model unavailable
                  </option>
                ) : null}
                {availableModels.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
          ) : instance ? (
            <p role="status">
              {availableModels?.reason ??
                (instance.state === "ready"
                  ? error
                    ? "Models unavailable. Refresh to try again."
                    : "Loading models…"
                  : "This agent connection is unavailable.")}
            </p>
          ) : null}
          {availableModels?.availability === "available" &&
          availableModels.models.length === 0 ? (
            <p role="status">No models are available for this connection.</p>
          ) : null}
          {snapshot.selection ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void select(null)}
            >
              Use Native for future attempts
            </button>
          ) : (
            <p className="text-xs text-zinc-400">Native selected</p>
          )}
        </>
      ) : null}
    </div>
  );
}
