import {
  ConnectProviderChooser,
} from "@legioncode/client-ui";
import {
  getLaunchSupportedProviders,
  ProviderIdSchema,
  type ProviderConnectionConfig,
  type ProviderId,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import { useEffect, useState } from "react";
import type { AppServerClient } from "@legioncode/sdk/platform/app-server-client";

import type { DesktopCredentialStatus } from "../../shared/desktop-api";

type Selection = { providerId: ProviderId; modelId: string };
type ModelOption = { id: string; name: string; deprecated?: boolean; availability?: string };

type Props = { client: AppServerClient | null; ready: boolean };

export function DesktopProviderSetup({ client, ready }: Props): React.JSX.Element {
  const [catalog, setCatalog] = useState<ProviderRegistryEntry[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [selectedCredentialStatus, setSelectedCredentialStatus] = useState<DesktopCredentialStatus["status"] | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [credentials, setCredentials] = useState<DesktopCredentialStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!client || !ready) return;
    let active = true;
    void Promise.all([client.getProviderCatalog(), client.getProviderSelection()])
      .then(async ([entries, selection]) => {
        const supported = getLaunchSupportedProviders(entries)
          .filter((entry) => entry.authModes.includes("api_key"));
        const statuses = await Promise.all(
          supported.map((provider) => window.desktop.credential({
            operation: "status",
            providerId: ProviderIdSchema.parse(provider.providerId),
          })),
        );
        if (!active) return;
        setCatalog(supported);
        setCredentials(statuses.filter((item): item is DesktopCredentialStatus =>
          !Array.isArray(item) && "status" in item,
        ));
        setSelected(selection);
        if (selection) {
          const credentialStatus = await window.desktop.credential({
            operation: "status",
            providerId: selection.providerId,
          });
          if (!active) return;
          if (!Array.isArray(credentialStatus) && "status" in credentialStatus) {
            setSelectedCredentialStatus(credentialStatus.status);
          }
          if (!Array.isArray(credentialStatus) && "status" in credentialStatus && credentialStatus.status === "present") {
            const discovered = await client.getProviderModels(selection.providerId);
            if (!active) return;
            setModels(toOptions(discovered.models));
          }
        }
      })
      .catch(() => {
        if (active) setLoadError("Provider catalog or selection could not be loaded.");
      });
    return () => { active = false; };
  }, [client, ready]);

  async function refreshStatus(providerId: ProviderId): Promise<void> {
    const result = await window.desktop.credential({ operation: "status", providerId });
    if (!Array.isArray(result) && "status" in result) {
      setCredentials((current) => [
        ...current.filter((item) => item.providerId !== providerId),
        result,
      ]);
      if (selected?.providerId === providerId) setSelectedCredentialStatus(result.status);
    }
  }

  async function connect(providerIdRaw: string, secret: string, _label?: string, config?: ProviderConnectionConfig): Promise<void> {
    const providerId = ProviderIdSchema.parse(providerIdRaw);
    if (!catalog.some((entry) => entry.providerId === providerId)) {
      throw new Error("This provider is not available in the current catalog.");
    }
    setConnecting(true);
    setConnectError(null);
    setSuccess(null);
    let credentialSaved = false;
    try {
      await window.desktop.credential({
        operation: "save",
        request: { providerId, apiKey: secret, ...(config ? { config } : {}) },
      });
      credentialSaved = true;
      await refreshStatus(providerId);
      if (!client) throw new Error("Provider selection is not ready.");
      const discovered = await client.getProviderModels(providerId);
      const availableModels = toOptions(discovered.models);
      if (availableModels.length === 0) {
        setSuccess("Credential saved. No registry-declared models are available for this provider yet.");
        return;
      }
      const nextSelection = await client.selectProvider(providerId, availableModels[0]!.id);
      setSelected(nextSelection);
      setSelectedCredentialStatus("present");
      setModels(availableModels);
      setSuccess("Provider credential saved and route selected.");
    } catch {
      setConnectError(credentialSaved
        ? "Credential saved in protected storage, but provider selection could not be completed. Retry model selection."
        : "Provider credential could not be saved. Check protected OS credential storage and retry.");
      throw new Error("Provider setup could not be completed");
    } finally {
      setConnecting(false);
    }
  }

  async function chooseModel(modelId: string): Promise<void> {
    if (!client || !selected) return;
    setConnectError(null);
    try {
      const next = await client.selectProvider(selected.providerId, modelId);
      setSelected(next);
      setSuccess("Provider model selection saved.");
    } catch {
      setConnectError("Provider model selection could not be saved.");
    }
  }

  async function removeCredential(providerId: ProviderId): Promise<void> {
    if (!client) return;
    try {
      await window.desktop.credential({ operation: "delete", providerId });
      await refreshStatus(providerId);
      if (selected?.providerId === providerId) {
        await client.clearProviderSelection();
        setSelected(null);
        setSelectedCredentialStatus(null);
        setModels([]);
      }
      setSuccess("Provider credential deleted.");
    } catch {
      setConnectError("Provider credential could not be deleted.");
    }
  }

  return (
    <section className="desktop-provider-setup" aria-labelledby="provider-heading">
      <p className="eyebrow">Inference provider</p>
      <h2 id="provider-heading">Provider setup</h2>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {selected ? (
        <div className="desktop-provider-selection" aria-label="Selected provider route">
          <p>
            {selectedCredentialStatus === "present" ? "Selected route" : "Stored route metadata"}: {catalog.find((item) => item.providerId === selected.providerId)?.displayName ?? selected.providerId}
            {" / "}{selected.modelId}
          </p>
          {selectedCredentialStatus && selectedCredentialStatus !== "present" ? (
            <p role="status">Credential: {selectedCredentialStatus === "missing" ? "Missing" : "Unavailable"}. Save a protected credential before using this route.</p>
          ) : null}
          {models.length > 0 ? (
            <label>
              Model
              <select value={selected.modelId} onChange={(event) => void chooseModel(event.currentTarget.value)}>
                {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </label>
          ) : <p role="status">No registry-declared models are available for this provider yet.</p>}
        </div>
      ) : <p>No provider route selected.</p>}
      <div className="desktop-provider-credentials" aria-label="Saved provider credentials">
        {credentials.map((credential) => (
          <div key={credential.providerId}>
            <span>{catalog.find((item) => item.providerId === credential.providerId)?.displayName ?? credential.providerId}: {credential.status === "present" ? "Saved" : credential.status === "missing" ? "Missing" : "Unavailable"}</span>
            {credential.status === "present" ? (
              <button type="button" onClick={() => void removeCredential(credential.providerId)}>
                Delete key
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {catalog.length > 0 ? (
        <ConnectProviderChooser
          catalog={catalog}
          onConnect={connect}
          isConnecting={connecting}
          error={connectError}
          errorRecovery={connectError ? {
            message: connectError,
            remediation: "Check that protected OS credential storage is available, then retry provider setup.",
          } : null}
          success={success}
          onErrorClear={() => setConnectError(null)}
          presentation="plain"
          showTitle={false}
        />
      ) : null}
    </section>
  );
}

function toOptions(models: readonly ModelOption[]): ModelOption[] {
  return models.filter((model) => !model.deprecated && model.availability !== "unsupported_transport");
}
