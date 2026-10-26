import { useMemo } from "react";
import { ThreadSidebar } from "@legioncode/client-ui";
import type { HostedSessionPullRequestsResponse } from "@legioncode/sdk";
import type {
  AgentSession,
  SessionHydrationStatus,
} from "../../hooks/useSessionManager";
import { projectAgentSessionsForSidebar } from "../../lib/session-sidebar-selectors";
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
  onRenameSession?: (id: string, title: string) => Promise<void>;
  onRemoveRepository?: (repo: string) => void;
  onRenameRepository?: (oldName: string, newName: string) => void;
  onClose?: () => void;
  onAddRepository: () => void;
  onOpenSettings: () => void;
  accountUser?: SidebarAccountUser | null;
  pullRequestsBySessionId?: ReadonlyMap<string, HostedSessionPullRequestsResponse>;
  onVisibleSelectionChange?: (selectionId: string, visible: boolean) => void;
  onPreviewSelectionChange?: (selectionId: string | null) => void;
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
  onRenameSession,
  onRemoveRepository,
  onRenameRepository,
  onClose,
  onAddRepository,
  onOpenSettings,
  accountUser,
  pullRequestsBySessionId,
  onVisibleSelectionChange,
  onPreviewSelectionChange,
  onLogout,
  width = 280,
}: AgentSidebarProps): React.ReactElement {
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
      onRenameSession={onRenameSession}
      pullRequestsBySessionId={pullRequestsBySessionId}
      onVisibleSelectionChange={onVisibleSelectionChange}
      onPreviewSelectionChange={onPreviewSelectionChange}
      onClose={onClose}
      footer={footer}
      width={width}
    />
  );
}
