import { useMemo } from "react";
import { ThreadSidebar } from "@legioncode/client-ui";
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
  onArchive: (id: string) => void | Promise<void>;
  onUnarchive?: (id: string) => void | Promise<void>;
  onRemoveRepository?: (repo: string) => void;
  onRenameRepository?: (oldName: string, newName: string) => void;
  onClose?: () => void;
  onAddRepository: () => void;
  onOpenSettings: () => void;
  accountUser?: SidebarAccountUser | null;
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
  onArchive,
  onUnarchive,
  onRemoveRepository,
  onRenameRepository,
  onClose,
  onAddRepository,
  onOpenSettings,
  accountUser,
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
      onOpenSettings={() => {
        onClose?.();
        onOpenSettings();
      }}
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
      onAddWorkspace={() => {
        onClose?.();
        onAddRepository();
      }}
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
      onUnarchive={(selectionId) => onUnarchive?.(selectionId)}
      footer={footer}
      width={width}
    />
  );
}
