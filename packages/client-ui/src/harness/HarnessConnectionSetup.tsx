import { useEffect, useRef, useState } from "react";
import type {
  BYOKCredential,
  ProviderRegistryEntry,
  HarnessClient,
  HarnessInstanceStatus,
  HarnessSetupRequest,
  HarnessStatusRequest,
} from "@legioncode/sdk";
import { getLaunchSupportedProviders } from "@repo/shared-types";

export interface HarnessConnectionSetupProps {
  client: HarnessClient;
  scope: HarnessStatusRequest;
  loadConnections: () => Promise<{
    credentials: readonly Pick<
      BYOKCredential,
      "credentialId" | "providerId" | "label"
    >[];
    catalog: readonly ProviderRegistryEntry[];
  }>;
  onSetup: (instance: HarnessInstanceStatus) => void;
}

/** API-key setup only. Credentials remain in the selected host's protected vault. */
export function HarnessConnectionSetup({
  client,
  scope,
  loadConnections,
  onSetup,
}: HarnessConnectionSetupProps) {
  const [data, setData] = useState<Awaited<
    ReturnType<HarnessConnectionSetupProps["loadConnections"]>
  > | null>(null);
  const [selectedHarness, setSelectedHarness] =
    useState<HarnessSetupRequest["harness"]>("codex");
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const command = useRef<HarnessSetupRequest | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void loadConnections()
      .then((result) => {
        if (active) setData(result);
      })
      .catch(() => {
        if (active)
          setError(
            "Saved API connections could not be loaded. Refresh to try again.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadConnections, refresh]);

  const providers = getLaunchSupportedProviders([
    ...(data?.catalog ?? []),
  ]).filter(
    (provider) =>
      provider.authModes.includes("api_key") && provider.providerId !== "axis",
  );
  const choices = (data?.credentials ?? []).flatMap((credential) => {
    const provider = providers.find(
      (entry) => entry.providerId === credential.providerId,
    );
    if (!provider) return [];
    if (selectedHarness === "codex" && credential.providerId !== "openai")
      return [];
    if (selectedHarness === "claude" && credential.providerId !== "anthropic")
      return [];
    return [{ ...credential, providerLabel: provider.displayName }];
  });
  const selected = choices.find((choice) => choice.credentialId === selectedId);
  async function setup() {
    if (inFlight.current || (!command.current && !selected)) return;
    if (!command.current && selected)
      command.current = {
        ...scope,
        harness: selectedHarness,
        connectionId: selected.credentialId,
        clientCommandId: crypto.randomUUID(),
      };
    const request = command.current;
    if (!request) return;
    inFlight.current = true;
    setPending(true);
    setBusy(true);
    setError(null);
    try {
      const result = await client.setup(request);
      if (!mounted.current) return;
      if (
        result.instance.workspaceId !== request.workspaceId ||
        result.instance.environmentId !== request.environmentId ||
        (result.instance.connectionId !== null &&
          result.instance.connectionId !== request.connectionId) ||
        result.instance.harness !== request.harness
      ) {
        throw new Error("Setup returned a different connection");
      }
      command.current = null;
      setPending(false);
      setSelectedId("");
      onSetup(result.instance);
    } catch {
      if (mounted.current)
        setError(
          "Setup was not confirmed. Retry to recover the same setup request; no other account will be selected.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div
      className="space-y-2 rounded-lg border border-zinc-700 p-3"
      aria-label="Set up an agent API connection"
    >
      <h4 className="font-medium">
        Set up an agent with a saved API connection
      </h4>
      <p className="text-sm text-zinc-400">
        Uses API billing. Subscription connections are separate. Availability is
        checked by this environment.
      </p>
      <label>
        Agent
        <select
          value={selectedHarness}
          disabled={loading || busy || pending}
          onChange={(event) => {
            if (inFlight.current || command.current) return;
            const harness = event.currentTarget.value;
            if (
              harness !== "codex" &&
              harness !== "opencode" &&
              harness !== "claude"
            ) return;
            setSelectedHarness(harness);
            setSelectedId("");
          }}
        >
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
          <option value="claude">Claude</option>
        </select>
      </label>
      {loading ? <p role="status">Loading saved API connections…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        disabled={loading || busy || pending}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh saved connections
      </button>
      {!loading && data && choices.length === 0 ? (
        <p>
          No eligible saved API connections for this agent. Add an API key in
          provider settings below, then refresh saved connections.
        </p>
      ) : null}
      {choices.length > 0 || pending ? (
        <>
          <label>
            Saved API connection
            <select
              value={selectedId}
              disabled={loading || busy || pending}
              onChange={(event) => {
                if (inFlight.current || command.current) return;
                setSelectedId(event.currentTarget.value);
              }}
            >
              <option value="">Choose an API connection</option>
              {pending && !selected ? (
                <option value={selectedId} disabled>
                  Previously selected connection
                </option>
              ) : null}
              {choices.map((choice) => (
                <option key={choice.credentialId} value={choice.credentialId}>
                  {choice.providerLabel} · {choice.label}
                </option>
              ))}
            </select>
          </label>
          {selected && selectedHarness === "codex" ? (
            <p role="status">
              Codex API-key setup does not provide execution identity. This
              route is unavailable for execution.
            </p>
          ) : null}
          <button
            type="button"
            disabled={loading || busy || (!selected && !pending)}
            onClick={() => void setup()}
          >
            {busy ? "Setting up…" : pending ? "Retry setup" : "Set up agent"}
          </button>
        </>
      ) : null}
    </div>
  );
}
