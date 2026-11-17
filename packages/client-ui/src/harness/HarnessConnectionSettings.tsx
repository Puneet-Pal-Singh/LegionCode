import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  HarnessInstanceStatus,
  HarnessSetupRequest,
  HarnessSetupResponse,
  HarnessStatusRequest,
  HarnessStatusResponse,
} from "@repo/platform-protocol";
import {
  HarnessConnectionSetup,
  harnessControlClass,
  harnessLabels,
  type HarnessConnectionLoader,
  type HarnessConnectionPlacement,
} from "./HarnessConnectionSetup.js";

/** The settings operations on the AppServerClient. */
export interface HarnessConnectionSettingsClient {
  setupHarness(params: HarnessSetupRequest): Promise<HarnessSetupResponse>;
  getHarnessStatus(
    params: HarnessStatusRequest,
  ): Promise<HarnessStatusResponse>;
}

export interface HarnessConnectionSettingsProps {
  client: HarnessConnectionSettingsClient | null;
  scope: HarnessStatusRequest | null;
  placement: HarnessConnectionPlacement;
  /** Pause reads while hidden and retain any in-memory pending configuration. */
  active?: boolean;
  loadConnections?: HarnessConnectionLoader;
}

const healthLabels: Record<HarnessInstanceStatus["state"], string> = {
  ready: "Ready",
  offline: "Offline",
  connecting: "Connecting",
  reauthentication_required: "Sign-in required",
  unavailable: "Unavailable",
};

function matchesScope(
  scope: HarnessStatusRequest,
  instance: HarnessInstanceStatus,
) {
  return (
    scope.workspaceId === instance.workspaceId &&
    scope.environmentId === instance.environmentId
  );
}

export function HarnessConnectionSettings({
  client,
  scope,
  placement,
  active = true,
  loadConnections,
}: HarnessConnectionSettingsProps) {
  const title = useId();
  return (
    <section aria-labelledby={title} className="my-4 grid gap-3 text-sm">
      <h3 id={title} className="text-base font-semibold">
        Agent connections
      </h3>
      <p className="text-[var(--lc-color-text-secondary)]">
        Experimental · {placement === "local" ? "Local" : "Cloud"}
      </p>
      <p>
        {placement === "local"
          ? "Local credentials stay on this host."
          : "Cloud connections use credentials authorized for this environment."}{" "}
        LegionCode Native and BYOK are configured separately in provider
        settings.
      </p>
      {client && scope ? (
        <ScopedSettings
          key={JSON.stringify([
            scope.workspaceId,
            scope.environmentId,
            placement,
          ])}
          client={client}
          scope={scope}
          placement={placement}
          active={active}
          loadConnections={loadConnections}
        />
      ) : (
        <p role="status">
          Open a workspace in an initialized environment to manage agent
          connections.
        </p>
      )}
    </section>
  );
}

interface ScopedProps extends Omit<
  HarnessConnectionSettingsProps,
  "client" | "scope"
> {
  client: HarnessConnectionSettingsClient;
  active: boolean;
  scope: HarnessStatusRequest;
}

type StatusRead =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; instances: readonly HarnessInstanceStatus[] };

type SetupState =
  | { state: "idle" }
  | { state: "submitting"; request: HarnessSetupRequest }
  | { state: "unconfirmed"; request: HarnessSetupRequest }
  | { state: "saved" };

function ScopedSettings({
  client,
  scope,
  placement,
  active,
  loadConnections,
}: ScopedProps) {
  const [status, setStatus] = useState<StatusRead>({ state: "loading" });
  const [setup, setSetup] = useState<SetupState>({ state: "idle" });
  const [created, setCreated] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const command = useRef<HarnessSetupRequest | null>(null);
  const inFlight = useRef(false);
  const { workspaceId, environmentId } = scope;

  useLayoutEffect(() => {
    setStatus({ state: "loading" });
    setSetup(
      command.current
        ? { state: "unconfirmed", request: command.current }
        : { state: "idle" },
    );
    return () => {
      generation.current++;
      inFlight.current = false;
    };
  }, [client]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    const readGeneration = generation.current;
    setStatus({ state: "loading" });
    const currentScope = { workspaceId, environmentId };
    async function readStatus() {
      try {
        const { instances } = await client.getHarnessStatus(currentScope);
        const ids = new Set(instances.map((instance) => instance.instanceId));
        if (
          ids.size !== instances.length ||
          instances.some((instance) => !matchesScope(currentScope, instance))
        ) {
          throw new Error("Mismatched harness status");
        }
        if (current && generation.current === readGeneration)
          setStatus({ state: "ready", instances });
      } catch {
        if (current && generation.current === readGeneration)
          setStatus({ state: "error" });
      }
    }

    void readStatus();
    return () => {
      current = false;
    };
  }, [client, workspaceId, environmentId, refresh, active]);

  function reload() {
    setStatus({ state: "loading" });
    setRefresh((value) => value + 1);
  }

  async function submit(
    intent: Pick<
      HarnessSetupRequest,
      "harness" | "connectionId" | "instanceId"
    >,
  ) {
    if (!active || inFlight.current) return;
    const request = command.current ?? {
      ...scope,
      ...intent,
      clientCommandId: crypto.randomUUID(),
    };
    command.current = request;
    inFlight.current = true;
    const submittedGeneration = generation.current;
    setSetup({ state: "submitting", request });

    try {
      const { instance } = await client.setupHarness(request);
      if (generation.current !== submittedGeneration) return;
      if (
        !matchesScope(request, instance) ||
        instance.harness !== request.harness ||
        instance.connectionId !== request.connectionId ||
        (request.instanceId !== undefined &&
          instance.instanceId !== request.instanceId)
      ) {
        throw new Error("Mismatched harness setup receipt");
      }
      command.current = null;
      if (request.instanceId === undefined) setCreated((value) => value + 1);
      setSetup({ state: "saved" });
      reload();
    } catch {
      if (generation.current === submittedGeneration)
        setSetup({ state: "unconfirmed", request });
    } finally {
      if (generation.current === submittedGeneration) inFlight.current = false;
    }
  }

  const locked = setup.state === "submitting" || setup.state === "unconfirmed";
  return (
    <>
      <button
        type="button"
        className={`${harnessControlClass} justify-self-start`}
        onClick={reload}
        disabled={status.state === "loading" || setup.state === "submitting"}
      >
        Refresh agent connections
      </button>
      {status.state === "loading" ? (
        <p role="status">Loading agent connections…</p>
      ) : null}
      {status.state === "error" ? (
        <p role="alert">
          Agent status could not be loaded. Refresh to try again.
        </p>
      ) : null}
      {status.state === "ready" && status.instances.length === 0 ? (
        <p>No agent configurations for this workspace.</p>
      ) : null}
      {status.state === "ready"
        ? status.instances.map((instance) => (
            <div
              key={instance.instanceId}
              className="grid gap-2 rounded-lg border border-[var(--lc-color-border-subtle)] p-3"
            >
              <h4 className="font-medium">
                {harnessLabels[instance.harness]} ·{" "}
                {instance.accountLabel ?? "Account unknown"}
              </h4>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt>Health</dt>
                <dd>{healthLabels[instance.state]}</dd>
                <dt>Runtime version</dt>
                <dd>{instance.runtimeVersion ?? "Unknown"}</dd>
                <dt>Last status report</dt>
                <dd>
                  <time dateTime={instance.observedAt}>
                    {new Date(instance.observedAt).toLocaleString()}
                  </time>
                </dd>
                <dt>Account quota</dt>
                <dd>
                  <AccountQuota quota={instance.usage?.quota} />
                </dd>
              </dl>
              {instance.reason ? <p>{instance.reason}</p> : null}
              {instance.connectionId !== null && instance.state !== "ready" ? (
                <button
                  type="button"
                  className={`${harnessControlClass} justify-self-start`}
                  aria-label={`Reconnect ${harnessLabels[instance.harness]} configuration${instance.accountLabel ? ` for ${instance.accountLabel}` : ""}`}
                  disabled={locked || instance.state === "connecting"}
                  onClick={() => {
                    if (instance.connectionId !== null)
                      void submit({
                        instanceId: instance.instanceId,
                        harness: instance.harness,
                        connectionId: instance.connectionId,
                      });
                  }}
                >
                  Reconnect configuration
                </button>
              ) : null}
            </div>
          ))
        : null}
      <p>
        Configuration saves a connection reference. Runtime installation,
        sign-in, and execution availability are checked separately.
      </p>
      {loadConnections ? (
        <HarnessConnectionSetup
          scope={scope}
          placement={placement}
          loadConnections={loadConnections}
          refresh={refresh}
          active={active}
          created={created}
          locked={locked}
          onConfigure={(choice) => void submit(choice)}
        />
      ) : (
        <p>Saved connection choices are unavailable in this environment.</p>
      )}
      {setup.state === "submitting" ? (
        <p role="status">Saving configuration…</p>
      ) : null}
      {setup.state === "saved" ? (
        <p role="status">Configuration saved.</p>
      ) : null}
      {setup.state === "unconfirmed" ? (
        <div className="grid gap-2">
          <p role="alert">
            The configuration change was unconfirmed. Retry the same request to
            recover its result.
          </p>
          <button
            type="button"
            className={`${harnessControlClass} justify-self-start`}
            onClick={() => void submit(setup.request)}
          >
            Retry configuration request
          </button>
        </div>
      ) : null}
    </>
  );
}

function AccountQuota({
  quota,
}: {
  quota: NonNullable<HarnessInstanceStatus["usage"]>["quota"] | undefined;
}) {
  const checkedAt = quota?.checkedAt;

  return (
    <>
      {quota?.windows?.length ? (
        <ul className="space-y-1">
          {quota.windows.map((window, index) => (
            <li key={index}>
              {window.label ?? "Quota window"}
              {": "}
              {window.remaining !== null
                ? `${window.remaining}${window.limit !== null ? ` of ${window.limit}` : ""} ${window.unit ?? ""} remaining`
                : window.utilizationPercent !== null
                  ? `${window.utilizationPercent}% used`
                  : "Unknown"}
              {quota.state === "stale" ? " (stale)" : ""}
              {window.resetsAt ? (
                <>
                  {" "}
                  · Resets{" "}
                  <time dateTime={window.resetsAt}>
                    {new Date(window.resetsAt).toLocaleString()}
                  </time>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>{quota?.state === "stale" ? "Unknown (stale)" : "Unknown"}</p>
      )}
      <p className="mt-1 text-[var(--lc-color-text-secondary)]">
        Last checked{" "}
        {checkedAt ? (
          <time dateTime={checkedAt}>
            {new Date(checkedAt).toLocaleString()}
          </time>
        ) : (
          "Not reported"
        )}
      </p>
    </>
  );
}
