import { useCallback, useMemo, useState } from "react";
import { ThreadSidebar } from "@legioncode/client-ui";
import type {
  AgentSession,
  SessionHydrationStatus,
} from "../../hooks/useSessionManager";
import { projectAgentSessionsForSidebar } from "../../lib/session-sidebar-selectors";
import { useSessionPullRequests } from "../../hooks/useSessionPullRequests";
import {
  SidebarAccountMenu,
  type SidebarAccountUser,
} from "./SidebarAccountMenu";

interface AgentSidebarProps {
  sessions: AgentSession[];
  repositories: string[];
  activeSessionId: string | null;
  hydrationStatus?: SessionHydrationStatus;
  onSelect: (id: string) => void;
  onCreate: (repo?: string) => void;
  onPin?: (id: string) => void | Promise<void>;
  onUnpin?: (id: string) => void | Promise<void>;
  onArchive: (id: string) => void | Promise<void>;
  onUnarchive?: (id: string) => void | Promise<void>;
  onRemoveRepository?: (repo: string) => void;
  onRenameRepository?: (oldName: string, newName: string) => void;
  onClose?: () => void;
  onAddRepository: () => void;
  onOpenSettings: () => void;
  accountUser?: SidebarAccountUser | null;
  accountId?: string | null;
  onLogout?: () => Promise<void>;
  width?: number;
}

export function AgentSidebar({
  sessions,
  repositories,
  activeSessionId,
  hydrationStatus = "ready",
  onSelect,
  onCreate,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  onRemoveRepository,
  onRenameRepository,
  onClose,
  onAddRepository,
  onOpenSettings,
  accountUser,
  accountId = null,
  onLogout,
  width = 280,
}: AgentSidebarProps): React.ReactElement {
  const [visibleSessionIds, setVisibleSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const { pullRequestsBySessionId, prioritizeSession } = useSessionPullRequests(
    sessions,
    visibleSessionIds,
    accountId,
  );
  const handleVisibleSelectionChange = useCallback((selectionId: string, visible: boolean) => {
    setVisibleSessionIds((current) => {
      if (current.has(selectionId) === visible) return current;
      const next = new Set(current);
      if (visible) next.add(selectionId);
      else next.delete(selectionId);
      return next;
    });
  }, []);
  const handlePreviewSelectionChange = useCallback((selectionId: string | null) => {
    prioritizeSession(selectionId);
  }, [prioritizeSession]);
  const model = useMemo(
    () =>
      projectAgentSessionsForSidebar({
        sessions,
        repositories,
        activeSessionId,
        hydrationStatus,
      }),
    [activeSessionId, hydrationStatus, repositories, sessions],
  );
  const footer = (
    <SidebarAccountMenu
      user={accountUser}
      onOpenSettings={onOpenSettings}
      onLogout={onLogout}
    />
  );

  return (
    <ThreadSidebar
      model={model}
      onSelect={onSelect}
      onCreate={(workspaceSelectionId) =>
        onCreate(
          workspaceSelectionId === "No repository"
            ? undefined
            : workspaceSelectionId,
        )
      }
      onAddWorkspace={onAddRepository}
      canManageWorkspace={(workspaceSelectionId) =>
        workspaceSelectionId !== "No repository"
      }
      onRenameWorkspace={
        onRenameRepository
          ? (workspaceSelectionId, newLabel) => {
              onRenameRepository(workspaceSelectionId, newLabel);
            }
          : undefined
      }
      onRemoveWorkspace={
        onRemoveRepository
          ? (workspaceSelectionId) => {
              onRemoveRepository(workspaceSelectionId);
            }
          : undefined
      }
      onArchive={(selectionId) => onArchive(selectionId)}
      onPin={onPin}
      onUnpin={onUnpin}
      onUnarchive={(selectionId) => onUnarchive?.(selectionId)}
      pullRequestsBySessionId={pullRequestsBySessionId}
      onVisibleSelectionChange={handleVisibleSelectionChange}
      onPreviewSelectionChange={handlePreviewSelectionChange}
      onClose={onClose}
      footer={footer}
      width={width}
    />
  );
}
