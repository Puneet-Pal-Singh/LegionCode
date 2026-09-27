import type { ThreadId, WorkspaceId } from "@repo/platform-protocol";

export type ThreadSidebarPlacement = "local" | "hosted";

export type ThreadSidebarDisplayStatus =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "paused"
  | "failed";

export type ThreadSidebarWorkspaceInput = {
  readonly label: string;
  readonly placement: ThreadSidebarPlacement;
} & (
  | {
      readonly workspaceId: WorkspaceId;
      readonly workspaceSelectionId?: string;
    }
  | { readonly workspaceId: null; readonly workspaceSelectionId: string }
);

export type ThreadSidebarThreadInput = {
  readonly selectionId: string;
  readonly threadId: ThreadId | null;
  readonly title: string;
  readonly updatedAt: string;
  readonly pinnedAt: string | null;
  readonly archivedAt: string | null;
  readonly displayStatus: ThreadSidebarDisplayStatus;
  readonly isUnread: boolean;
} & (
  | {
      readonly workspaceId: WorkspaceId;
      readonly workspaceSelectionId?: string;
    }
  | { readonly workspaceId: null; readonly workspaceSelectionId: string }
);

export type ThreadSidebarSourceState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready" };

export interface ProjectThreadSidebarInput {
  readonly state: ThreadSidebarSourceState;
  readonly workspaces: readonly ThreadSidebarWorkspaceInput[];
  readonly threads: readonly ThreadSidebarThreadInput[];
  readonly selectedSelectionId: string | null;
}

export interface ThreadSidebarItem {
  readonly selectionId: string;
  readonly threadId: ThreadId | null;
  readonly workspaceId: WorkspaceId | null;
  readonly workspaceSelectionId: string;
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
  readonly workspaceId: WorkspaceId | null;
  readonly workspaceSelectionId: string;
  readonly label: string | null;
  readonly placement: ThreadSidebarPlacement | null;
  readonly threads: readonly ThreadSidebarItem[];
}

export interface ThreadSidebarReadModel {
  readonly status: "loading" | "error" | "empty" | "ready";
  readonly error?: string;
  readonly selectedSelectionId: string | null;
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
    return emptyReadModel(
      "loading",
      input.selectedSelectionId,
      workspaceGroups,
    );
  }
  if (input.state.status === "error") {
    return {
      ...emptyReadModel("error", input.selectedSelectionId, workspaceGroups),
      error: input.state.message,
    };
  }

  const workspaces = new Map(
    input.workspaces.map((workspace) => [selectionId(workspace), workspace]),
  );
  const items = input.threads.map((thread) => {
    const workspaceSelectionId = selectionId(thread);
    const workspace = workspaces.get(workspaceSelectionId);
    return {
      selectionId: thread.selectionId,
      threadId: thread.threadId,
      workspaceId: thread.workspaceId,
      workspaceSelectionId,
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
      isSelected: thread.selectionId === input.selectedSelectionId,
    } satisfies ThreadSidebarItem;
  });

  const pinned = items
    .filter((item) => !item.isArchived && item.isPinned)
    .sort(comparePinned);
  const archived = items.filter((item) => item.isArchived).sort(compareUpdated);
  const grouped = new Map<string, ThreadSidebarItem[]>(
    workspaceGroups.map((group) => [
      group.workspaceSelectionId,
      [...group.threads],
    ]),
  );
  for (const item of items) {
    if (item.isArchived || item.isPinned) continue;
    grouped.set(item.workspaceSelectionId, [
      ...(grouped.get(item.workspaceSelectionId) ?? []),
      item,
    ]);
  }

  const projectedWorkspaceGroups = Array.from(
    grouped,
    ([workspaceSelectionId, threads]) => {
      const workspace = workspaces.get(workspaceSelectionId);
      return {
        workspaceId: workspace?.workspaceId ?? null,
        workspaceSelectionId,
        label: workspace?.label ?? null,
        placement: workspace?.placement ?? null,
        threads: threads.sort(compareUpdated),
      } satisfies ThreadSidebarWorkspaceGroup;
    },
  ).sort(
    (left, right) =>
      (left.label ?? "").localeCompare(right.label ?? "") ||
      left.workspaceSelectionId.localeCompare(right.workspaceSelectionId),
  );

  return {
    status: input.threads.length === 0 ? "empty" : "ready",
    selectedSelectionId: input.selectedSelectionId,
    pinned,
    workspaceGroups: projectedWorkspaceGroups,
    archived,
  };
}

function emptyReadModel(
  status: "loading" | "error" | "empty",
  selectedSelectionId: string | null,
  workspaceGroups: readonly ThreadSidebarWorkspaceGroup[],
): ThreadSidebarReadModel {
  return {
    status,
    selectedSelectionId,
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
      workspaceSelectionId: selectionId(workspace),
      label: workspace.label,
      placement: workspace.placement,
      threads: [],
    }))
    .sort(
      (left, right) =>
        (left.label ?? "").localeCompare(right.label ?? "") ||
        left.workspaceSelectionId.localeCompare(right.workspaceSelectionId),
    );
}

function selectionId(
  value:
    | {
        readonly workspaceId: WorkspaceId;
        readonly workspaceSelectionId?: string;
      }
    | {
        readonly workspaceId: null;
        readonly workspaceSelectionId: string;
      },
): string {
  if (value.workspaceSelectionId !== undefined)
    return value.workspaceSelectionId;
  if (value.workspaceId !== null) return value.workspaceId;
  throw new Error(
    "A workspace without a canonical id requires a selection identity",
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
    left.selectionId.localeCompare(right.selectionId)
  );
}
