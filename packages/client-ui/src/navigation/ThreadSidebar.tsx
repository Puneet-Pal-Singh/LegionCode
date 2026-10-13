import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, FolderPlus, MoreHorizontal, Pin, Search, SquarePen, PanelLeftClose, X } from "lucide-react";
import type { ThreadSidebarDisplayStatus, ThreadSidebarItem, ThreadSidebarReadModel } from "@legioncode/sdk";
import { ThreadSidebarGroup, type ThreadSidebarEntry } from "./ThreadSidebarGroup.js";

type WorkspaceSelectionId = string;
type StatusFilter = ThreadSidebarDisplayStatus | "all";

const FILTER_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All tasks" },
  { value: "waiting_for_approval", label: "Awaiting approval" },
  { value: "running", label: "Running" },
  { value: "paused", label: "Paused" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Completed" },
  { value: "idle", label: "Idle" },
];
const INITIAL_VISIBLE_ROWS = 5;
const LOAD_MORE_ROWS = 10;

export interface ThreadSidebarProps {
  model: ThreadSidebarReadModel;
  onSelect: (selectionId: string) => void;
  onCreate?: (workspaceSelectionId?: WorkspaceSelectionId) => void;
  onAddWorkspace?: () => void;
  onRenameWorkspace?: (workspaceSelectionId: WorkspaceSelectionId, newLabel: string) => void | Promise<void>;
  onRemoveWorkspace?: (workspaceSelectionId: WorkspaceSelectionId) => void | Promise<void>;
  canManageWorkspace?: (workspaceSelectionId: WorkspaceSelectionId) => boolean;
  onArchive?: (selectionId: string) => void | Promise<void>;
  onUnarchive?: (selectionId: string) => void | Promise<void>;
  onClose?: () => void;
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
  onClose,
  brand = (
    <div className="truncate pl-2 text-lg font-semibold tracking-tight">
      <span className="text-zinc-100">Legion</span>
      <span className="text-zinc-500">Code</span>
    </div>
  ),
  footer,
  width = 280,
}: ThreadSidebarProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);
  const [pendingArchiveId, setPendingArchiveId] = useState<string | null>(null);
  const [isArchivedOpen, setIsArchivedOpen] = useState(false);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleCounts, setVisibleCounts] = useState<Readonly<Record<string, number>>>({});
  const [focusedIndex, setFocusedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const normalizedQuery = query.trim().toLocaleLowerCase();

  useEffect(() => {
    if (isSearchOpen) searchInputRef.current?.focus();
  }, [isSearchOpen]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      if (filterMenuRef.current && !filterMenuRef.current.contains(event.target as Node)) {
        setIsFilterMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const groups = useMemo(
    () => model.workspaceGroups
      .map((group) => {
        const workspaceMatches = Boolean(
          normalizedQuery && group.label?.toLocaleLowerCase().includes(normalizedQuery),
        );
        return {
          workspaceId: group.workspaceId,
          workspaceSelectionId: group.workspaceSelectionId,
          label: group.label,
          placement: group.placement,
          threads: group.threads.filter((thread) =>
            matches(thread, workspaceMatches ? "" : normalizedQuery, statusFilter),
          ),
        };
      })
      .filter((group) =>
        !normalizedQuery ||
        group.label?.toLocaleLowerCase().includes(normalizedQuery) ||
        group.threads.length > 0,
      ),
    [model.workspaceGroups, normalizedQuery, statusFilter],
  );
  const pinned = model.pinned.filter((thread) =>
    matches(thread, normalizedQuery, statusFilter) ||
    Boolean(
      normalizedQuery &&
      thread.workspaceLabel?.toLocaleLowerCase().includes(normalizedQuery) &&
      matches(thread, "", statusFilter),
    ),
  );
  const archived = model.status === "ready"
    ? model.archived.filter((thread) => matches(thread, normalizedQuery, statusFilter))
    : [];
  const visiblePinned = visibleItems(pinned, visibleCounts["\0pinned"] ?? INITIAL_VISIBLE_ROWS);
  const visibleGroups = groups.map((group) => ({
    ...group,
    visibleThreads: visibleItems(group.threads, visibleCounts[group.workspaceSelectionId] ?? INITIAL_VISIBLE_ROWS),
  }));
  const visibleArchived = visibleItems(archived, visibleCounts["\0archived"] ?? INITIAL_VISIBLE_ROWS);
  const entries: ThreadSidebarEntry[] = [
    ...visiblePinned.map((item) => ({ item, workspaceLabel: "Pinned" })),
    ...visibleGroups.flatMap((group) => collapsedWorkspaces.has(group.workspaceSelectionId)
      ? []
      : group.visibleThreads.map((item) => ({ item, workspaceLabel: group.label ?? "Unknown workspace" }))),
    ...(isArchivedOpen
      ? visibleArchived.map((item) => ({ item, workspaceLabel: item.workspaceLabel ?? "Unknown workspace" }))
      : []),
  ];
  const activeIndex = entries.length === 0 ? 0 : Math.min(focusedIndex, entries.length - 1);

  function focusAt(index: number): void {
    if (entries.length === 0) return;
    const nextIndex = (index + entries.length) % entries.length;
    setFocusedIndex(nextIndex);
    rowRefs.current.get(entries[nextIndex]!.item.selectionId)?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number, item: ThreadSidebarItem): void {
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
    <aside className="ui-sidebar-surface flex h-full flex-col overflow-hidden border-r" style={{ width }} aria-label="Workspace navigation">
      <div className="flex h-14 shrink-0 items-center px-4">
        <div className="min-w-0 flex-1">{brand}</div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            title="Close sidebar"
            className="grid size-8 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200"
          >
            <PanelLeftClose size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div data-testid="sidebar-utility" className="shrink-0 px-4 pb-3 pt-3">
        <div className="space-y-1">
          {onCreate ? (
            <button
              type="button"
              onClick={() => onCreate()}
              className="grid h-9 w-full grid-cols-[2rem_minmax(0,1fr)] items-center rounded-lg text-left text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-800/65 hover:text-white"
            >
              <span className="flex size-8 items-center justify-center"><SquarePen size={16} aria-hidden="true" /></span>
              <span>New task</span>
            </button>
          ) : null}
          {isSearchOpen ? (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" size={15} aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setFocusedIndex(0); }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setQuery("");
                    setIsSearchOpen(false);
                  }
                }}
                placeholder="Search tasks and projects"
                className="ui-input h-9 w-full rounded-lg pl-9 pr-9 text-sm text-zinc-300"
                aria-label="Search tasks"
              />
              <button
                type="button"
                onClick={() => { setQuery(""); setIsSearchOpen(false); }}
                aria-label="Close search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-300"
              ><X size={14} aria-hidden="true" /></button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsSearchOpen(true)}
              className="grid h-9 w-full grid-cols-[2rem_minmax(0,1fr)] items-center rounded-lg text-left text-sm font-medium text-zinc-100 transition hover:bg-zinc-800/55 hover:text-white"
            >
              <span className="flex size-8 items-center justify-center"><Search size={16} aria-hidden="true" /></span>
              <span>Search</span>
            </button>
          )}
        </div>
      </div>

      <nav className="sidebar-scroll-region flex-1 overflow-y-auto px-4 pb-3 pt-3" aria-label="Threads">
        {model.status === "loading" ? <p className="px-2 py-3 text-xs text-zinc-500" role="status">Loading threads…</p> : null}
        {model.status === "error" ? <p className="px-2 py-3 text-xs text-red-300" role="alert">{model.error || "Could not load threads."}</p> : null}
        {model.status === "empty" ? <p className="px-2 py-3 text-xs italic text-zinc-600">No tasks yet</p> : null}
        {model.status === "ready" || model.status === "empty" ? (
          <div className="space-y-2">
            <div className="group/projects flex h-8 items-center justify-between px-2">
              <span className="text-sm font-medium text-zinc-500">Projects</span>
              <div className="flex items-center gap-1">
                {onAddWorkspace ? (
                  <button type="button" aria-label="Add project" title="Add project" onClick={onAddWorkspace} className="rounded-md p-1.5 text-zinc-500 opacity-0 transition hover:bg-zinc-800/60 hover:text-zinc-200 focus-visible:opacity-100 group-hover/projects:opacity-100">
                    <FolderPlus size={14} aria-hidden="true" />
                  </button>
                ) : null}
                <div className="relative" ref={filterMenuRef}>
                  <button type="button" aria-label="Filter tasks" title="Filter tasks" aria-haspopup="menu" aria-expanded={isFilterMenuOpen} onClick={() => setIsFilterMenuOpen((open) => !open)} className="rounded-md p-1.5 text-zinc-500 opacity-0 transition hover:bg-zinc-800/60 hover:text-zinc-200 focus-visible:opacity-100 group-hover/projects:opacity-100">
                    <MoreHorizontal size={14} aria-hidden="true" className={statusFilter !== "all" ? "text-emerald-300" : undefined} />
                  </button>
                  {isFilterMenuOpen ? (
                    <div role="menu" className="ui-surface-popover absolute right-0 top-8 z-30 w-48 p-2">
                      <div className="px-2 pb-1 pt-1 text-sm text-zinc-500">Show tasks</div>
                      {FILTER_OPTIONS.map((option) => (
                        <button key={option.value} type="button" role="menuitemradio" aria-checked={statusFilter === option.value} onClick={() => { setStatusFilter(option.value); setIsFilterMenuOpen(false); setFocusedIndex(0); }} className="flex min-h-9 w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800">
                          <span>{option.label}</span>{statusFilter === option.value ? <Check size={14} className="text-zinc-300" aria-hidden="true" /> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            <div
              role="listbox"
              aria-label="Thread list"
              aria-activedescendant={entries[activeIndex] ? `thread-${entries[activeIndex].item.selectionId}` : undefined}
            >
            {pinned.length > 0 ? (
              <section className="space-y-1">
                <div className="grid h-9 grid-cols-[2rem_minmax(0,1fr)] items-center">
                  <span className="flex size-8 items-center justify-center text-zinc-500"><Pin size={14} aria-hidden="true" /></span>
                  <span className="text-sm font-semibold text-zinc-100">Pinned</span>
                </div>
                <ThreadSidebarGroup
                  label="Pinned"
                  entries={visiblePinned.map((item) => ({ item, workspaceLabel: "Pinned" }))}
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
                  hasMore={visiblePinned.length < pinned.length}
                  onShowMore={() => setVisibleCounts((current) => ({
                    ...current,
                    ["\0pinned"]: Math.min((current["\0pinned"] ?? INITIAL_VISIBLE_ROWS) + LOAD_MORE_ROWS, pinned.length),
                  }))}
                />
              </section>
            ) : null}
            {visibleGroups.map((group) => {
              const groupEntries = group.visibleThreads.map((item) => ({ item, workspaceLabel: group.label ?? "Unknown workspace" }));
              const startIndex = entries.findIndex((entry) => entry.item.selectionId === groupEntries[0]?.item.selectionId);
              const isExpanded = !collapsedWorkspaces.has(group.workspaceSelectionId);
              const isManageable = canManageWorkspace?.(group.workspaceSelectionId) ?? true;
              const label = group.label ?? "Unknown workspace";
              return (
                <ThreadSidebarGroup
                  key={group.workspaceSelectionId}
                  label={label}
                  workspaceSelectionId={group.workspaceSelectionId}
                  expanded={isExpanded}
                  onToggle={() => setCollapsedWorkspaces((current) => {
                    const next = new Set(current);
                    if (next.has(group.workspaceSelectionId)) next.delete(group.workspaceSelectionId);
                    else next.add(group.workspaceSelectionId);
                    return next;
                  })}
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
                  onCreate={onCreate ? () => onCreate(group.workspaceSelectionId) : undefined}
                  placement={group.placement}
                  onRenameWorkspace={isManageable ? onRenameWorkspace : undefined}
                  onRemoveWorkspace={isManageable ? onRemoveWorkspace : undefined}
                  hasMore={group.visibleThreads.length < group.threads.length}
                  onShowMore={() => setVisibleCounts((current) => ({
                    ...current,
                    [group.workspaceSelectionId]: Math.min((current[group.workspaceSelectionId] ?? INITIAL_VISIBLE_ROWS) + LOAD_MORE_ROWS, group.threads.length),
                  }))}
                />
              );
            })}
            {archived.length > 0 ? (
              <section className="space-y-1">
                <button type="button" aria-expanded={isArchivedOpen} onClick={() => setIsArchivedOpen((open) => !open)} className="flex h-8 w-full items-center justify-between px-2 text-sm font-medium text-zinc-500 hover:text-zinc-300">
                  <span>Archived</span><span aria-hidden="true">{isArchivedOpen ? "▾" : "▸"}</span>
                </button>
                {isArchivedOpen ? (
                  <ThreadSidebarGroup
                    label="Archived threads"
                    archived
                    entries={visibleArchived.map((item) => ({ item, workspaceLabel: item.workspaceLabel ?? "Unknown workspace" }))}
                    startIndex={entries.findIndex((entry) => entry.item.isArchived)}
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
                    hasMore={visibleArchived.length < archived.length}
                    onShowMore={() => setVisibleCounts((current) => ({
                      ...current,
                      ["\0archived"]: Math.min((current["\0archived"] ?? INITIAL_VISIBLE_ROWS) + LOAD_MORE_ROWS, archived.length),
                    }))}
                  />
                ) : null}
              </section>
            ) : null}
            {model.status === "ready" && entries.length === 0 && archived.length === 0 ? <p className="px-2 py-3 text-xs italic text-zinc-600">No matching tasks or projects</p> : null}
            </div>
          </div>
        ) : null}
      </nav>
      {footer ? <div className="border-t ui-muted-divider px-4 py-2">{footer}</div> : null}
    </aside>
  );
}

function matches(item: ThreadSidebarItem, query: string, statusFilter: StatusFilter): boolean {
  return (statusFilter === "all" || item.displayStatus === statusFilter) &&
    (!query || item.title.toLocaleLowerCase().includes(query));
}

function visibleItems(items: ThreadSidebarItem[], limit: number): ThreadSidebarItem[] {
  if (items.length <= limit) return items;
  const selectedIndex = items.findIndex((item) => item.isSelected);
  if (selectedIndex < 0 || selectedIndex < limit) return items.slice(0, limit);
  return [...items.slice(0, limit - 1), items[selectedIndex]!];
}
