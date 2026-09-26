import { useMemo } from "react";
import {
  ThreadSidebar,
} from "@legioncode/client-ui";
import {
  workspaceIdFromExternalId,
  type ThreadId,
} from "@legioncode/sdk";
type WorkspaceId = ReturnType<typeof workspaceIdFromExternalId>;
import type { AgentSession, SessionHydrationStatus } from "../../hooks/useSessionManager";
import {
  projectAgentSessionsForSidebar,
  type SidebarRepository,
} from "../../lib/session-sidebar-selectors";
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
  const repositoryByWorkspaceId = useMemo(() => {
    const entries: Array<[WorkspaceId, SidebarRepository]> = [
      ...repositories.map((repository) => [
        workspaceIdFromExternalId(repository),
        { id: repository, label: repository },
      ] as [WorkspaceId, SidebarRepository]),
      ...sessions
        .filter((session) => session.repository?.trim())
        .map((session) => [
          workspaceIdFromExternalId(session.repository!.trim()),
          { id: session.repository!.trim(), label: session.repository!.trim() },
        ] as [WorkspaceId, SidebarRepository]),
    ];
    return new Map(entries);
  }, [repositories, sessions]);

  const footer = (
    <SidebarAccountMenu
      user={accountUser}
      onOpenSettings={onOpenSettings}
      onLogout={onLogout}
    />
  );

  const workspaceFor = (workspaceId: WorkspaceId): SidebarRepository | undefined =>
    repositoryByWorkspaceId.get(workspaceId);

  const threadId = (id: ThreadId): string => id;

  return (
    <ThreadSidebar
      model={model}
      onSelect={(id) => {
        onSelect(threadId(id));
        onClose?.();
      }}
      onCreate={(workspaceId) =>
        onCreate(workspaceId ? workspaceFor(workspaceId)?.id : undefined)
      }
      onAddWorkspace={onAddRepository}
      onRenameWorkspace={(workspaceId, newLabel) => {
        const workspace = workspaceFor(workspaceId);
        if (workspace) onRenameRepository?.(workspace.id, newLabel);
      }}
      onRemoveWorkspace={(workspaceId) => {
        const workspace = workspaceFor(workspaceId);
        if (workspace) onRemoveRepository?.(workspace.id);
      }}
      onArchive={(id) => onArchive(threadId(id))}
      onUnarchive={(id) => onUnarchive?.(threadId(id))}
      footer={footer}
      width={width}
    />
  );
}
