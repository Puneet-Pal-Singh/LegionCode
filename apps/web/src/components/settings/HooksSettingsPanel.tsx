import { useCallback, useEffect, useMemo, useState } from "react";
import { HooksSettingsView } from "@legioncode/client-ui";
import type { HookSettingsAuditReadModel } from "@legioncode/sdk";
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
  const [expandedSource, setExpandedSource] = useState<string | null>(null);

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
  const sourceGroups = useMemo(() => {
    const bySource = new Map<
      string,
      (typeof groups)[number]["rows"][number][]
    >();
    for (const group of groups) {
      for (const row of group.rows) {
        bySource.set(row.sourceLabel, [
          ...(bySource.get(row.sourceLabel) ?? []),
          row,
        ]);
      }
    }
    return [...bySource.entries()];
  }, [groups]);

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

  return (
    <HooksSettingsView
      workspaceAvailable={Boolean(workspaceId)}
      sourceGroups={sourceGroups}
      groupCount={groups.length}
      loadState={loadState}
      error={error}
      savingHandlerId={savingHandlerId}
      pendingRemovalHandlerId={pendingRemovalHandlerId}
      expandedSource={expandedSource}
      setExpandedSource={setExpandedSource}
      setPendingRemovalHandlerId={setPendingRemovalHandlerId}
      onRefresh={loadDefinitions}
      onUpdateEnabled={updateEnabled}
      onRemoveDefinition={removeDefinition}
    />
  );
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Hook settings could not be updated. Try again.";
}
