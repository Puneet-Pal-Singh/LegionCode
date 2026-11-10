import { ThreadSidebar, type ThreadSidebarProps } from "@legioncode/client-ui";
import { projectThreadSidebar, type ThreadSidebarThreadInput } from "@legioncode/sdk";
import type { LocalWorkspaceGrant, LocalWorkspaceProject, Thread } from "@repo/platform-protocol";
import { useMemo } from "react";

export interface DesktopSidebarProps extends Pick<ThreadSidebarProps,
  "visible" | "onSelect" | "onCreate" | "onAddWorkspace" | "onRenameSession" |
  "onPin" | "onUnpin" | "onArchive" | "onUnarchive" | "onClose" |
  "onOpenSettings" | "onRemoveWorkspace" | "canManageWorkspace" | "width"
> {
  workspace: LocalWorkspaceGrant | null;
  projects: readonly LocalWorkspaceProject[];
  threads: readonly Thread[];
  selectedThreadId: Thread["id"] | null;
  loadState: "loading" | "ready" | "error";
  threadError?: string | null;
  /** Optional presentation supplied by canonical SDK replay/read receipts. */
  threadPresentation?: ReadonlyMap<Thread["id"], Pick<ThreadSidebarThreadInput, "displayStatus" | "isUnread">>;
}

/** Local data/command adapter; Web and Desktop render the same sidebar source. */
export function DesktopSidebar({
  workspace,
  projects,
  threads,
  selectedThreadId,
  loadState,
  threadError,
  threadPresentation,
  ...actions
}: DesktopSidebarProps): React.JSX.Element {
  const model = useMemo(() => projectThreadSidebar({
    state: loadState === "error"
      ? { status: "error", message: "The local thread list could not be loaded." }
      : { status: loadState },
    workspaces: [
      ...projects.map((project) => ({
        workspaceId: project.workspaceId,
        label: project.displayName ?? "Unknown workspace",
        placement: "local" as const,
      })),
      ...(workspace && !projects.some((project) => project.workspaceId === workspace.workspaceId) ? [{
        workspaceId: workspace.workspaceId, label: workspace.displayName, placement: "local" as const,
      }] : []),
    ],
    threads: threads.map((thread) => ({
      selectionId: thread.id,
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      title: thread.title,
      updatedAt: thread.updatedAt,
      pinnedAt: thread.pinnedAt,
      archivedAt: thread.archivedAt,
      // Thread metadata alone does not establish live activity or unread state.
      displayStatus: threadPresentation?.get(thread.id)?.displayStatus ?? "idle",
      isUnread: threadPresentation?.get(thread.id)?.isUnread ?? false,
    })),
    selectedSelectionId: selectedThreadId,
  }), [loadState, workspace, projects, threads, selectedThreadId, threadPresentation]);

  return (
    <ThreadSidebar
      {...actions}
      model={model}
      collapsibleProjects
      retainWorkspaceGroups
      mutationError={threadError}
      pullRequestUnavailableReason="Pull request status is unavailable."
    />
  );
}
