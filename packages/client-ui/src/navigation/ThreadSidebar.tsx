import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  ThreadSidebarDisplayStatus,
  ThreadSidebarItem,
  ThreadSidebarReadModel,
} from "@legioncode/sdk";
import {
  ThreadSidebarGroup,
  type ThreadSidebarEntry,
} from "./ThreadSidebarGroup.js";

type WorkspaceSelectionId = string;

export interface ThreadSidebarProps {
  model: ThreadSidebarReadModel;
  onSelect: (selectionId: string) => void;
  onCreate?: (workspaceSelectionId?: WorkspaceSelectionId) => void;
  onAddWorkspace?: () => void;
  onRenameWorkspace?: (
    workspaceSelectionId: WorkspaceSelectionId,
    newLabel: string,
  ) => void | Promise<void>;
  onRemoveWorkspace?: (
    workspaceSelectionId: WorkspaceSelectionId,
  ) => void | Promise<void>;
  canManageWorkspace?: (workspaceSelectionId: WorkspaceSelectionId) => boolean;
  onArchive?: (selectionId: string) => void | Promise<void>;
  onUnarchive?: (selectionId: string) => void | Promise<void>;
  brand?: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function ThreadSidebar({
  model,
  onSelect,
  onCreate,
  onAddWorkspace,
  onRenameWorkspace,
  onRemoveWorkspace,
  canManageWorkspace,
  onArchive,
  onUnarchive,
  brand = (
    <span className="lc-thread-sidebar-brand">
      Legion<span>Code</span>
    </span>
  ),
  footer,
  width = 280,
}: ThreadSidebarProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    ThreadSidebarDisplayStatus | "all"
  >("all");
  const [pendingArchiveId, setPendingArchiveId] = useState<string | null>(null);
  const [isArchivedOpen, setIsArchivedOpen] = useState(false);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = useMemo(
    () =>
      model.workspaceGroups
        .map((group) => {
          const workspaceMatches = Boolean(
            normalizedQuery &&
            group.label?.toLocaleLowerCase().includes(normalizedQuery),
          );
          return {
            workspaceId: group.workspaceId,
            workspaceSelectionId: group.workspaceSelectionId,
            label: group.label,
            placement: group.placement,
            threads: group.threads.filter((thread) =>
              matches(
                thread,
                workspaceMatches ? "" : normalizedQuery,
                statusFilter,
              ),
            ),
          };
        })
        .filter(
          (group) =>
            !normalizedQuery ||
            group.label?.toLocaleLowerCase().includes(normalizedQuery) ||
            group.threads.length > 0,
        ),
    [model.workspaceGroups, normalizedQuery, statusFilter],
  );
  const pinned = model.pinned.filter(
    (thread) =>
      matches(thread, normalizedQuery, statusFilter) ||
      Boolean(
        normalizedQuery &&
        thread.workspaceLabel?.toLocaleLowerCase().includes(normalizedQuery) &&
        matches(thread, "", statusFilter),
      ),
  );
  const archived =
    model.status === "ready"
      ? model.archived.filter((thread) =>
          matches(thread, normalizedQuery, statusFilter),
        )
      : [];
  const entries: ThreadSidebarEntry[] = [
    ...pinned.map((item) => ({ item, workspaceLabel: "Pinned" })),
    ...groups.flatMap((group) =>
      collapsedWorkspaces.has(group.workspaceSelectionId)
        ? []
        : group.threads.map((item) => ({
            item,
            workspaceLabel: group.label ?? "Unknown workspace",
          })),
    ),
    ...(isArchivedOpen
      ? archived.map((item) => ({
          item,
          workspaceLabel: item.workspaceLabel ?? "Unknown workspace",
        }))
      : []),
  ];
  const activeIndex =
    entries.length === 0 ? 0 : Math.min(focusedIndex, entries.length - 1);

  function focusAt(index: number): void {
    if (entries.length === 0) return;
    const nextIndex = (index + entries.length) % entries.length;
    setFocusedIndex(nextIndex);
    rowRefs.current.get(entries[nextIndex]!.item.selectionId)?.focus();
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    item: ThreadSidebarItem,
  ): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(item.selectionId);
    }
  }

  async function confirmArchive(selectionId: string): Promise<void> {
    if (!onArchive) return;
    await onArchive(selectionId);
    setPendingArchiveId(null);
  }

  return (
    <aside
      className="lc-thread-sidebar"
      style={{ width }}
      aria-label="Workspace navigation"
    >
      <div className="lc-thread-sidebar-header">{brand}</div>
      <div className="lc-thread-sidebar-tools">
        {onCreate ? (
          <button
            className="lc-thread-sidebar-new"
            type="button"
            onClick={() => onCreate()}
          >
            <span aria-hidden="true">＋</span> New thread
          </button>
        ) : null}
        {onAddWorkspace ? (
          <button
            className="lc-thread-sidebar-add-workspace"
            type="button"
            onClick={onAddWorkspace}
          >
            ＋ Add workspace
          </button>
        ) : null}
        <label
          className="lc-thread-sidebar-search-label"
          htmlFor="lc-thread-sidebar-search"
        >
          Search
        </label>
        <input
          id="lc-thread-sidebar-search"
          className="lc-thread-sidebar-search"
          type="search"
          placeholder="Search threads and projects"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setFocusedIndex(0);
          }}
        />
        <label
          className="lc-thread-sidebar-filter-label"
          htmlFor="lc-thread-sidebar-filter"
        >
          Filter threads
        </label>
        <select
          id="lc-thread-sidebar-filter"
          className="lc-thread-sidebar-filter"
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(
              event.currentTarget.value as ThreadSidebarDisplayStatus | "all",
            )
          }
        >
          <option value="all">All threads</option>
          <option value="running">Running</option>
          <option value="waiting_for_approval">Awaiting approval</option>
          <option value="completed">Completed</option>
          <option value="paused">Paused</option>
          <option value="failed">Failed</option>
          <option value="idle">Idle</option>
        </select>
      </div>
      <nav className="lc-thread-sidebar-list" aria-label="Threads">
        {model.status === "loading" ? (
          <p className="lc-thread-sidebar-message" role="status">
            Loading threads…
          </p>
        ) : null}
        {model.status === "error" ? (
          <p
            className="lc-thread-sidebar-message lc-thread-sidebar-error"
            role="alert"
          >
            {model.error || "Could not load threads."}
          </p>
        ) : null}
        {model.status === "empty" ? (
          <p className="lc-thread-sidebar-message">No threads yet</p>
        ) : null}
        {model.status === "ready" &&
        entries.length === 0 &&
        archived.length === 0 ? (
          <p className="lc-thread-sidebar-message">No matching threads</p>
        ) : null}
        {model.status === "ready" || model.status === "empty" ? (
          <div
            role="listbox"
            aria-label="Thread list"
            aria-activedescendant={
              entries[activeIndex]
                ? `thread-${entries[activeIndex].item.selectionId}`
                : undefined
            }
          >
            {pinned.length > 0 ? (
              <ThreadSidebarGroup
                label="Pinned"
                entries={entries.filter((entry) => entry.item.isPinned)}
                startIndex={0}
                focusedIndex={activeIndex}
                rowRefs={rowRefs.current}
                pendingArchiveId={pendingArchiveId}
                onFocus={setFocusedIndex}
                onKeyDown={handleKeyDown}
                onSelect={onSelect}
                onArchive={onArchive}
                onConfirmArchive={confirmArchive}
                onCancelArchive={() => setPendingArchiveId(null)}
                setPendingArchiveId={setPendingArchiveId}
              />
            ) : null}
            {groups.map((group) => {
              const groupEntries = group.threads.map((item) => ({
                item,
                workspaceLabel: group.label ?? "Unknown workspace",
              }));
              const startIndex = entries.findIndex(
                (entry) =>
                  entry.item.selectionId === groupEntries[0]?.item.selectionId,
              );
              const isExpanded = !collapsedWorkspaces.has(
                group.workspaceSelectionId,
              );
              const isManageable =
                canManageWorkspace?.(group.workspaceSelectionId) ?? true;
              const label = group.label ?? "Unknown workspace";
              return (
                <ThreadSidebarGroup
                  key={group.workspaceSelectionId}
                  label={label}
                  workspaceSelectionId={group.workspaceSelectionId}
                  placement={group.placement}
                  expanded={isExpanded}
                  onToggle={() =>
                    setCollapsedWorkspaces((current) => {
                      const next = new Set(current);
                      if (next.has(group.workspaceSelectionId))
                        next.delete(group.workspaceSelectionId);
                      else next.add(group.workspaceSelectionId);
                      return next;
                    })
                  }
                  entries={isExpanded ? groupEntries : []}
                  startIndex={Math.max(0, startIndex)}
                  focusedIndex={activeIndex}
                  rowRefs={rowRefs.current}
                  pendingArchiveId={pendingArchiveId}
                  onFocus={setFocusedIndex}
                  onKeyDown={handleKeyDown}
                  onSelect={onSelect}
                  onArchive={onArchive}
                  onConfirmArchive={confirmArchive}
                  onCancelArchive={() => setPendingArchiveId(null)}
                  setPendingArchiveId={setPendingArchiveId}
                  onCreate={
                    onCreate
                      ? () => onCreate(group.workspaceSelectionId)
                      : undefined
                  }
                  onRenameWorkspace={
                    isManageable ? onRenameWorkspace : undefined
                  }
                  onRemoveWorkspace={
                    isManageable ? onRemoveWorkspace : undefined
                  }
                />
              );
            })}
            {archived.length > 0 ? (
              <section className="lc-thread-sidebar-group">
                <button
                  className="lc-thread-sidebar-group-heading lc-thread-sidebar-archived-toggle"
                  type="button"
                  aria-expanded={isArchivedOpen}
                  onClick={() => setIsArchivedOpen((open) => !open)}
                >
                  Archived <span>{isArchivedOpen ? "▾" : "▸"}</span>
                </button>
                {isArchivedOpen ? (
                  <ThreadSidebarGroup
                    label="Archived threads"
                    archived
                    entries={archived.map((item) => ({
                      item,
                      workspaceLabel:
                        item.workspaceLabel ?? "Unknown workspace",
                    }))}
                    startIndex={entries.findIndex(
                      (entry) => entry.item.isArchived,
                    )}
                    focusedIndex={activeIndex}
                    rowRefs={rowRefs.current}
                    pendingArchiveId={pendingArchiveId}
                    onFocus={setFocusedIndex}
                    onKeyDown={handleKeyDown}
                    onSelect={onSelect}
                    onConfirmArchive={confirmArchive}
                    onCancelArchive={() => setPendingArchiveId(null)}
                    setPendingArchiveId={setPendingArchiveId}
                    onUnarchive={onUnarchive}
                  />
                ) : null}
              </section>
            ) : null}
          </div>
        ) : null}
      </nav>
      {footer ? <div className="lc-thread-sidebar-footer">{footer}</div> : null}
    </aside>
  );
}

function matches(
  item: ThreadSidebarItem,
  query: string,
  statusFilter: ThreadSidebarDisplayStatus | "all",
): boolean {
  return (
    (statusFilter === "all" || item.displayStatus === statusFilter) &&
    (!query || item.title.toLocaleLowerCase().includes(query))
  );
}
