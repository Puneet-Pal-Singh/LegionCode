import {
  ArchivedChatsSettingsView,
  type ArchivedSettingsItem,
} from "@legioncode/client-ui";
import type { AppServerClient } from "@legioncode/sdk";
import type { Thread } from "@repo/platform-protocol";
import { useEffect, useRef, useState } from "react";

export function DesktopArchivedSettings({
  client,
  ready,
  onUnarchiveThread,
}: {
  client: AppServerClient | null;
  ready: boolean;
  onUnarchiveThread?: (threadId: Thread["id"]) => Promise<void>;
}) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [rows, setRows] = useState<ArchivedSettingsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<object | null>(null);
  useEffect(() => {
    const scope = {};
    active.current = scope;
    setError(null);
    setRows([]);
    setThreads([]);
    if (!client || !ready) {
      setLoading(false);
      return () => {
        active.current = null;
      };
    }
    setLoading(true);
    void Promise.all([client.getWorkspaceGrant(), client.listThreads()])
      .then(([workspace, result]) => {
        if (active.current !== scope) return;
        const archived = result.filter(
          (thread) =>
            thread.status === "archived" &&
            thread.workspaceId === workspace?.workspaceId,
        );
        setThreads(archived);
        setRows(
          archived.map((thread) => ({
            id: thread.id,
            name: thread.title,
            repository: workspace?.displayName,
            archivedAt: thread.archivedAt,
            updatedAt: thread.updatedAt,
          })),
        );
      })
      .catch(() => {
        if (active.current === scope)
          setError(
            "Archived tasks could not be loaded. Restore workspace access and reopen settings.",
          );
      })
      .finally(() => {
        if (active.current === scope) setLoading(false);
      });
    return () => {
      if (active.current === scope) active.current = null;
    };
  }, [client, ready]);
  return (
    <ArchivedChatsSettingsView
      sessions={rows}
      isLoading={loading}
      error={error}
      removeSession={(id) =>
        setRows((current) => current.filter((item) => item.id !== id))
      }
      onUnarchiveSession={async (id) => {
        const thread = threads.find((item) => item.id === id);
        const scope = active.current;
        if (!thread || !client || !scope)
          throw new Error("Archived task scope changed.");
        try {
          if (onUnarchiveThread) await onUnarchiveThread(thread.id);
          else await client.unarchiveThread(thread.id);
          if (active.current !== scope)
            throw new Error("Archived task scope changed.");
        } catch {
          if (active.current === scope)
            setError(
              "Task could not be unarchived. Restore workspace access and retry.",
            );
          throw new Error("Task could not be unarchived.");
        }
      }}
      deletionUnavailableReason="Permanent task deletion is not available in this local environment. Unarchive preserves the saved conversation."
    />
  );
}
