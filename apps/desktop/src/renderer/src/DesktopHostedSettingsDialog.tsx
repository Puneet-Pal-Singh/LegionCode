import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArchivedChatsSettingsView,
  ComposerSettingsSection,
  HooksSettingsView,
  SharedProviderDialog,
  SharedSettingsDialog,
  updateComposerPreferences,
  useComposerPreferences,
  type ProviderSettingsPort,
  type SettingsSection,
} from "@legioncode/client-ui";
import type { AppServerClient, HostedSession } from "@legioncode/sdk";
import { DesktopHostedAccount } from "./DesktopHostedAccount";
import type { DesktopHostedAccountControls } from "./useDesktopHostedAccount";

type ArchivedClient = Pick<AppServerClient, "listArchivedSessions" | "unarchiveSession" | "deleteArchivedSession">;
export interface DesktopHostedSettingsDialogProps {
  readonly open: boolean;
  readonly active: boolean;
  readonly onClose: () => void;
  readonly provider: ProviderSettingsPort;
  readonly hostedAccount: DesktopHostedAccountControls;
  /** Account-scoped hosted client, independent of the selected provider workspace. */
  readonly client: ArchivedClient | null;
  readonly initialSection?: SettingsSection;
  readonly providerDialogVariant?: "connect-only" | "manage-models-only" | null;
  readonly onSessionsChanged?: () => void | Promise<void>;
}

/** Shared settings presentation over hosted commands; local keys are never consulted. */
export function DesktopHostedSettingsDialog({ open, active, onClose, provider, hostedAccount,
  client, initialSection = "general", providerDialogVariant, onSessionsChanged }: DesktopHostedSettingsDialogProps) {
  const preferences = useComposerPreferences();
  const isOpen = open && active;
  if (providerDialogVariant) return <SharedProviderDialog
    isOpen={isOpen}
    onClose={onClose}
    variant={providerDialogVariant}
    provider={provider}
    recoveryAdvice={(message) => ({ message: message ?? "Hosted provider configuration is unavailable.",
      remediation: "Check your hosted account and workspace access, then reconnect or select a provider." })}
  />;
  return <SharedSettingsDialog
    isOpen={isOpen}
    onClose={onClose}
    initialSection={initialSection}
    provider={provider}
    generalScopeDescription="Provider connections and model visibility belong to the selected hosted workspace. Keys saved on this computer are not uploaded to Cloud."
    composerSettings={<>
      <DesktopHostedAccount controls={hostedAccount} />
      <ComposerSettingsSection preferences={preferences} onChange={updateComposerPreferences} />
    </>}
    archivedContent={<HostedArchivedSettings client={client} account={hostedAccount}
      enabled={isOpen} onSessionsChanged={onSessionsChanged} />}
    hooksContent={<HooksSettingsView unavailableReason="Hook definition management is not connected in Desktop Cloud settings. This panel does not enable or execute hooks." />}
  />;
}

interface ArchiveScope {
  readonly client: ArchivedClient;
  readonly accountId: string;
  readonly key: string;
  rows: HostedSession[];
  mutation: { key: string; promise: Promise<void> } | null;
}
function HostedArchivedSettings({ client, account, enabled, onSessionsChanged }: {
  client: ArchivedClient | null;
  account: DesktopHostedAccountControls;
  enabled: boolean;
  onSessionsChanged?: () => void | Promise<void>;
}) {
  const snapshot = account.snapshot;
  const accountId = snapshot?.state === "signed_in" ? snapshot.account?.id : undefined;
  const scope = useMemo<ArchiveScope | null>(() => enabled && client && accountId
    ? { client, accountId, key: JSON.stringify([snapshot?.target, accountId, snapshot?.generation]), rows: [], mutation: null }
    : null, [client, accountId, snapshot?.target, snapshot?.generation, enabled]);
  const live = useRef<ArchiveScope | null>(scope);
  const [read, setRead] = useState<{ scope: ArchiveScope; rows: HostedSession[]; loading: boolean; error: string | null } | null>(null);
  useLayoutEffect(() => {
    live.current = scope;
    return () => { if (live.current === scope) live.current = null; };
  }, [scope]);
  useEffect(() => {
    if (!scope) return;
    let observing = true;
    setRead({ scope, rows: [], loading: true, error: null });
    void scope.client.listArchivedSessions().then((rows) => {
      if (!observing || live.current !== scope) return;
      if (rows.some((row) => row.userId !== scope.accountId || row.archivedAt === null))
        throw new Error("Hosted archived records do not match this account.");
      scope.rows = rows;
      setRead({ scope, rows, loading: false, error: null });
    }).catch(() => {
      if (observing && live.current === scope)
        setRead({ scope, rows: [], loading: false, error: "Archived cloud chats could not be loaded. Check account access and reopen settings." });
    });
    return () => { observing = false; };
  }, [scope]);
  const requireCurrent = (): ArchiveScope => {
    if (!scope || live.current !== scope) throw new Error("Hosted archived chat scope changed.");
    return scope;
  };
  const remove = (expected: ArchiveScope, id: string): void => {
    if (live.current !== expected) return;
    expected.rows = expected.rows.filter((row) => row.id !== id);
    setRead((current) => current?.scope === expected ? { ...current, rows: expected.rows } : current);
  };
  const mutate = (id: string, operation: "restore" | "delete"): Promise<void> => {
    const expected = requireCurrent();
    const key = `${operation}:${id}`;
    if (expected.mutation) return expected.mutation.key === key ? expected.mutation.promise
      : Promise.reject(new Error("Wait for the current archived chat change to finish."));
    const row = expected.rows.find((item) => item.id === id && item.archivedAt !== null && item.userId === expected.accountId);
    if (!row) return Promise.reject(new Error("Reload archived chats before changing this conversation."));
    const promise = Promise.resolve().then(async () => {
      if (live.current !== expected) throw new Error("Hosted archived chat scope changed.");
      if (operation === "restore") {
        const restored = await expected.client.unarchiveSession(id);
        if (restored.id !== id || restored.userId !== expected.accountId || restored.archivedAt !== null ||
            restored.workspaceId !== row.workspaceId || restored.repository !== row.repository)
          throw new Error("The restored cloud chat did not match its archived identity.");
      } else await expected.client.deleteArchivedSession(id);
      if (live.current !== expected) throw new Error("Hosted archived chat scope changed.");
      remove(expected, id);
      // A sidebar refresh failure cannot turn a confirmed mutation into another request.
      void Promise.resolve().then(onSessionsChanged).catch(() => {
        if (live.current === expected) setRead((current) => current?.scope === expected
          ? { ...current, error: "The archived chat changed, but the sidebar could not refresh. Reopen the cloud task list." } : current);
      });
    }).catch((error: unknown) => {
      if (live.current === expected) setRead((current) => current?.scope === expected
        ? { ...current, error: "The archived cloud chat change could not be confirmed. Reopen settings before retrying." } : current);
      throw error;
    }).finally(() => {
      if (expected.mutation?.promise === promise) expected.mutation = null;
    });
    expected.mutation = { key, promise };
    return promise;
  };
  const current = read?.scope === scope ? read : null;
  return <ArchivedChatsSettingsView
    sessions={(current?.rows ?? []).map((row) => ({ id: row.id, name: row.title, repository: row.repository,
      archivedAt: row.archivedAt, updatedAt: row.updatedAt }))}
    isLoading={Boolean(scope && (!current || current.loading))}
    error={scope ? current?.error ?? null : "Sign in to view archived cloud chats."}
    onUnarchiveSession={(id) => mutate(id, "restore")}
    removeSession={(id) => { if (scope) remove(scope, id); }}
    deleteSession={(id) => mutate(id, "delete")}
    deletionUnavailableReason="Bulk deletion is not connected in Desktop Cloud settings. Individual archived chats can be deleted or restored."
  />;
}
