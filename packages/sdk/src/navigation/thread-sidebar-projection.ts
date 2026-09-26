import type { ThreadId, WorkspaceId } from "@repo/platform-protocol";

export type ThreadSidebarPlacement = "local" | "hosted";

export type ThreadSidebarDisplayStatus =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "paused"
  | "failed";

export interface ThreadSidebarWorkspaceInput {
  readonly workspaceId: WorkspaceId;
  readonly label: string;
  readonly placement: ThreadSidebarPlacement;
}

export interface ThreadSidebarThreadInput {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly updatedAt: string;
  readonly pinnedAt: string | null;
  readonly archivedAt: string | null;
  readonly displayStatus: ThreadSidebarDisplayStatus;
  readonly isUnread: boolean;
}

export type ThreadSidebarSourceState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready" };

export interface ProjectThreadSidebarInput {
  readonly state: ThreadSidebarSourceState;
  readonly workspaces: readonly ThreadSidebarWorkspaceInput[];
  readonly threads: readonly ThreadSidebarThreadInput[];
  readonly selectedThreadId: ThreadId | null;
}

export interface ThreadSidebarItem {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceLabel: string | null;
  readonly placement: ThreadSidebarPlacement | null;
  readonly title: string;
  readonly updatedAt: string;
  readonly pinnedAt: string | null;
  readonly archivedAt: string | null;
  readonly displayStatus: ThreadSidebarDisplayStatus;
  readonly isUnread: boolean;
  readonly isPinned: boolean;
  readonly isArchived: boolean;
  readonly isSelected: boolean;
}

export interface ThreadSidebarWorkspaceGroup {
  readonly workspaceId: WorkspaceId;
  readonly label: string | null;
  readonly placement: ThreadSidebarPlacement | null;
  readonly threads: readonly ThreadSidebarItem[];
}

export interface ThreadSidebarReadModel {
  readonly status: "loading" | "error" | "empty" | "ready";
  readonly error?: string;
  readonly selectedThreadId: ThreadId | null;
  readonly pinned: readonly ThreadSidebarItem[];
  readonly workspaceGroups: readonly ThreadSidebarWorkspaceGroup[];
  readonly archived: readonly ThreadSidebarItem[];
}

/** Projects normalized Thread/workspace data for the shared client sidebar. */
export function projectThreadSidebar(
  input: ProjectThreadSidebarInput,
): ThreadSidebarReadModel {
  const workspaceGroups = createWorkspaceGroups(input.workspaces);
  if (input.state.status === "loading") {
    return emptyReadModel("loading", input.selectedThreadId, workspaceGroups);
  }
  if (input.state.status === "error") {
    return {
      ...emptyReadModel("error", input.selectedThreadId, workspaceGroups),
      error: input.state.message,
    };
  }

  const workspaces = new Map(
    input.workspaces.map((workspace) => [workspace.workspaceId, workspace]),
  );
  const items = input.threads.map((thread) => {
    const workspace = workspaces.get(thread.workspaceId);
    return {
      threadId: thread.threadId,
      workspaceId: thread.workspaceId,
      workspaceLabel: workspace?.label ?? null,
      placement: workspace?.placement ?? null,
      title: thread.title,
      updatedAt: thread.updatedAt,
      pinnedAt: thread.pinnedAt,
      archivedAt: thread.archivedAt,
      displayStatus: thread.displayStatus,
      isUnread: thread.isUnread,
      isPinned: thread.pinnedAt !== null,
      isArchived: thread.archivedAt !== null,
      isSelected: thread.threadId === input.selectedThreadId,
    } satisfies ThreadSidebarItem;
  });

  const pinned = items
    .filter((item) => !item.isArchived && item.isPinned)
    .sort(comparePinned);
  const archived = items.filter((item) => item.isArchived).sort(compareUpdated);
  const grouped = new Map<WorkspaceId, ThreadSidebarItem[]>(
    workspaceGroups.map((group) => [group.workspaceId, [...group.threads]]),
  );
  for (const item of items) {
    if (item.isArchived || item.isPinned) continue;
    grouped.set(item.workspaceId, [
      ...(grouped.get(item.workspaceId) ?? []),
      item,
    ]);
  }

  const projectedWorkspaceGroups = Array.from(
    grouped,
    ([workspaceId, threads]) => {
      const workspace = workspaces.get(workspaceId);
      return {
        workspaceId,
        label: workspace?.label ?? null,
        placement: workspace?.placement ?? null,
        threads: threads.sort(compareUpdated),
      } satisfies ThreadSidebarWorkspaceGroup;
    },
  ).sort(
    (left, right) =>
      (left.label ?? "").localeCompare(right.label ?? "") ||
      left.workspaceId.localeCompare(right.workspaceId),
  );

  return {
    status: input.threads.length === 0 ? "empty" : "ready",
    selectedThreadId: input.selectedThreadId,
    pinned,
    workspaceGroups: projectedWorkspaceGroups,
    archived,
  };
}

function emptyReadModel(
  status: "loading" | "error" | "empty",
  selectedThreadId: ThreadId | null,
  workspaceGroups: readonly ThreadSidebarWorkspaceGroup[],
): ThreadSidebarReadModel {
  return {
    status,
    selectedThreadId,
    pinned: [],
    workspaceGroups,
    archived: [],
  };
}

function createWorkspaceGroups(
  workspaces: readonly ThreadSidebarWorkspaceInput[],
): ThreadSidebarWorkspaceGroup[] {
  return workspaces
    .map((workspace) => ({
      workspaceId: workspace.workspaceId,
      label: workspace.label,
      placement: workspace.placement,
      threads: [],
    }))
    .sort(
      (left, right) =>
        (left.label ?? "").localeCompare(right.label ?? "") ||
        left.workspaceId.localeCompare(right.workspaceId),
    );
}

function comparePinned(
  left: ThreadSidebarItem,
  right: ThreadSidebarItem,
): number {
  return (
    (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "") ||
    compareUpdated(left, right)
  );
}

function compareUpdated(
  left: ThreadSidebarItem,
  right: ThreadSidebarItem,
): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.threadId.localeCompare(right.threadId)
  );
}
