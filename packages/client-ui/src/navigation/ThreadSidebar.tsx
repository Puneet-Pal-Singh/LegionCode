import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ThreadId, ThreadSidebarDisplayStatus, ThreadSidebarItem, ThreadSidebarReadModel, ThreadSidebarWorkspaceInput } from "@legioncode/sdk";

type WorkspaceId = ThreadSidebarWorkspaceInput["workspaceId"];

export interface ThreadSidebarProps {
  model: ThreadSidebarReadModel;
  onSelect: (threadId: ThreadId) => void;
  onCreate?: (workspaceId?: WorkspaceId) => void;
  onAddWorkspace?: () => void;
  onRenameWorkspace?: (workspaceId: WorkspaceId, newLabel: string) => void | Promise<void>;
  onRemoveWorkspace?: (workspaceId: WorkspaceId) => void | Promise<void>;
  onArchive?: (threadId: ThreadId) => void | Promise<void>;
  onUnarchive?: (threadId: ThreadId) => void | Promise<void>;
  brand?: ReactNode;
  footer?: ReactNode;
  width?: number;
}

type SidebarEntry = { item: ThreadSidebarItem; workspaceLabel: string };

export function ThreadSidebar({
  model,
  onSelect,
  onCreate,
  onAddWorkspace,
  onRenameWorkspace,
  onRemoveWorkspace,
  onArchive,
  onUnarchive,
  brand = <span className="lc-thread-sidebar-brand">Legion<span>Code</span></span>,
  footer,
  width = 280,
}: ThreadSidebarProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ThreadSidebarDisplayStatus | "all">("all");
  const [pendingArchiveId, setPendingArchiveId] = useState<ThreadId | null>(null);
  const [isArchivedOpen, setIsArchivedOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef(new Map<ThreadId, HTMLButtonElement>());
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = useMemo(
    () => model.workspaceGroups.map((group) => ({
      workspaceId: group.workspaceId,
      label: group.label,
      placement: group.placement,
      threads: group.threads.filter((thread) => matches(thread, normalizedQuery, statusFilter)),
    })).filter((group) => !normalizedQuery || group.label?.toLocaleLowerCase().includes(normalizedQuery) || group.threads.length > 0),
    [model.workspaceGroups, normalizedQuery, statusFilter],
  );
  const pinned = model.pinned.filter((thread) => matches(thread, normalizedQuery, statusFilter));
  const archived = model.status === "ready"
    ? model.archived.filter((thread) => matches(thread, normalizedQuery, statusFilter))
    : [];
  const entries: SidebarEntry[] = [
    ...pinned.map((item) => ({ item, workspaceLabel: "Pinned" })),
    ...groups.flatMap((group) => group.threads.map((item) => ({
      item,
      workspaceLabel: group.label ?? "Unknown workspace",
    }))),
    ...(isArchivedOpen ? archived.map((item) => ({ item, workspaceLabel: item.workspaceLabel ?? "Unknown workspace" })) : []),
  ];

  function focusAt(index: number): void {
    if (entries.length === 0) return;
    const nextIndex = (index + entries.length) % entries.length;
    setFocusedIndex(nextIndex);
    rowRefs.current.get(entries[nextIndex]!.item.threadId)?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number, item: ThreadSidebarItem): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(item.threadId);
    }
  }

  async function confirmArchive(threadId: ThreadId): Promise<void> {
    if (!onArchive) return;
    await onArchive(threadId);
    setPendingArchiveId(null);
  }

  return (
    <aside className="lc-thread-sidebar" style={{ width }} aria-label="Workspace navigation">
      <div className="lc-thread-sidebar-header">{brand}</div>
      <div className="lc-thread-sidebar-tools">
        {onCreate ? <button className="lc-thread-sidebar-new" type="button" onClick={() => onCreate()}>
          <span aria-hidden="true">＋</span> New thread
        </button> : null}
        {onAddWorkspace ? <button className="lc-thread-sidebar-add-workspace" type="button" onClick={onAddWorkspace}>＋ Add workspace</button> : null}
        <label className="lc-thread-sidebar-search-label" htmlFor="lc-thread-sidebar-search">Search</label>
        <input
          id="lc-thread-sidebar-search"
          className="lc-thread-sidebar-search"
          type="search"
          placeholder="Search threads and projects"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setFocusedIndex(0); }}
        />
        <label className="lc-thread-sidebar-filter-label" htmlFor="lc-thread-sidebar-filter">Filter threads</label>
        <select id="lc-thread-sidebar-filter" className="lc-thread-sidebar-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as ThreadSidebarDisplayStatus | "all")}>
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
        {model.status === "loading" ? <p className="lc-thread-sidebar-message" role="status">Loading threads…</p> : null}
        {model.status === "error" ? <p className="lc-thread-sidebar-message lc-thread-sidebar-error" role="alert">{model.error || "Could not load threads."}</p> : null}
        {model.status === "empty" ? <p className="lc-thread-sidebar-message">No threads yet</p> : null}
        {model.status === "ready" && entries.length === 0 && archived.length === 0 ? <p className="lc-thread-sidebar-message">No matching threads</p> : null}
        {model.status === "ready" || model.status === "empty" ? (
          <div role="listbox" aria-label="Thread list" aria-activedescendant={entries[focusedIndex] ? `thread-${entries[focusedIndex].item.threadId}` : undefined}>
            {pinned.length > 0 ? <ThreadGroup label="Pinned" entries={entries.filter((entry) => entry.item.isPinned)} startIndex={0} focusedIndex={focusedIndex} rowRefs={rowRefs.current} pendingArchiveId={pendingArchiveId} onFocus={setFocusedIndex} onKeyDown={handleKeyDown} onSelect={onSelect} onArchive={onArchive} onConfirmArchive={confirmArchive} onCancelArchive={() => setPendingArchiveId(null)} setPendingArchiveId={setPendingArchiveId} /> : null}
            {groups.map((group) => {
              const groupEntries = group.threads.map((item) => ({ item, workspaceLabel: group.label ?? "Unknown workspace" }));
              const startIndex = entries.findIndex((entry) => entry.item.threadId === groupEntries[0]?.item.threadId);
              return <ThreadGroup key={group.workspaceId} label={group.label ?? "Unknown workspace"} workspaceId={group.workspaceId} placement={group.placement} entries={groupEntries} startIndex={Math.max(0, startIndex)} focusedIndex={focusedIndex} rowRefs={rowRefs.current} pendingArchiveId={pendingArchiveId} onFocus={setFocusedIndex} onKeyDown={handleKeyDown} onSelect={onSelect} onArchive={onArchive} onConfirmArchive={confirmArchive} onCancelArchive={() => setPendingArchiveId(null)} setPendingArchiveId={setPendingArchiveId} onCreate={onCreate ? () => onCreate(group.workspaceId) : undefined} onRenameWorkspace={onRenameWorkspace} onRemoveWorkspace={onRemoveWorkspace} />;
            })}
            {archived.length > 0 ? <section className="lc-thread-sidebar-group">
              <button className="lc-thread-sidebar-group-heading lc-thread-sidebar-archived-toggle" type="button" aria-expanded={isArchivedOpen} onClick={() => setIsArchivedOpen((open) => !open)}>Archived <span>{isArchivedOpen ? "▾" : "▸"}</span></button>
              {isArchivedOpen ? <ThreadGroup label="Archived threads" archived entries={archived.map((item) => ({ item, workspaceLabel: item.workspaceLabel ?? "Unknown workspace" }))} startIndex={entries.findIndex((entry) => entry.item.isArchived)} focusedIndex={focusedIndex} rowRefs={rowRefs.current} pendingArchiveId={pendingArchiveId} onFocus={setFocusedIndex} onKeyDown={handleKeyDown} onSelect={onSelect} onConfirmArchive={confirmArchive} onCancelArchive={() => setPendingArchiveId(null)} setPendingArchiveId={setPendingArchiveId} onUnarchive={onUnarchive} /> : null}
            </section> : null}
          </div>
        ) : null}
      </nav>
      {footer ? <div className="lc-thread-sidebar-footer">{footer}</div> : null}
    </aside>
  );
}

interface ThreadGroupProps {
  label: string;
  workspaceId?: WorkspaceId;
  placement?: "local" | "hosted" | null;
  entries: SidebarEntry[];
  startIndex: number;
  focusedIndex: number;
  rowRefs: Map<ThreadId, HTMLButtonElement>;
  pendingArchiveId: string | null;
  onFocus: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number, item: ThreadSidebarItem) => void;
  onSelect: (threadId: ThreadId) => void;
  onArchive?: (threadId: ThreadId) => void | Promise<void>;
  onUnarchive?: (threadId: ThreadId) => void | Promise<void>;
  archived?: boolean;
  onConfirmArchive: (threadId: ThreadId) => Promise<void>;
  onCancelArchive: () => void;
  setPendingArchiveId: (threadId: ThreadId | null) => void;
  onCreate?: () => void;
  onRenameWorkspace?: (workspaceId: WorkspaceId, newLabel: string) => void | Promise<void>;
  onRemoveWorkspace?: (workspaceId: WorkspaceId) => void | Promise<void>;
}

function ThreadGroup(props: ThreadGroupProps): React.ReactElement {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState(props.label);
  const [isConfirmingWorkspaceRemoval, setIsConfirmingWorkspaceRemoval] = useState(false);

  return <section className="lc-thread-sidebar-group" aria-label={props.label}>
    <div className="lc-thread-sidebar-group-heading">
      {isRenaming && props.workspaceId && props.onRenameWorkspace ? <form className="lc-thread-sidebar-rename-form" onSubmit={(event) => { event.preventDefault(); void props.onRenameWorkspace?.(props.workspaceId!, draftLabel.trim()); setIsRenaming(false); }}>
        <input aria-label={`Rename ${props.label}`} value={draftLabel} autoFocus onChange={(event) => setDraftLabel(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") setIsRenaming(false); }} />
        <button type="submit" disabled={!draftLabel.trim()}>Save</button>
        <button type="button" onClick={() => { setDraftLabel(props.label); setIsRenaming(false); }}>Cancel</button>
      </form> : <span>{props.label}</span>}
      {props.placement ? <small>{props.placement === "local" ? "Local" : "Hosted"}</small> : null}
      {props.onCreate ? <button type="button" aria-label={`New thread in ${props.label}`} onClick={props.onCreate}>＋</button> : null}
      {props.workspaceId && props.onRenameWorkspace ? <button type="button" aria-label={`Rename workspace ${props.label}`} onClick={() => { setDraftLabel(props.label); setIsRenaming(true); }}>Rename</button> : null}
      {props.workspaceId && props.onRemoveWorkspace ? <button type="button" aria-label={`Remove workspace ${props.label}`} onClick={() => setIsConfirmingWorkspaceRemoval(true)}>Remove</button> : null}
    </div>
    {isConfirmingWorkspaceRemoval && props.workspaceId && props.onRemoveWorkspace ? <div className="lc-thread-sidebar-remove-confirm" role="group" aria-label={`Confirm removal of ${props.label}`}>
      <span>Remove workspace?</span>
      <button type="button" onClick={() => setIsConfirmingWorkspaceRemoval(false)}>Cancel</button>
      <button type="button" onClick={() => { void props.onRemoveWorkspace?.(props.workspaceId!); setIsConfirmingWorkspaceRemoval(false); }}>Confirm</button>
    </div> : null}
    <ul>
      {props.entries.map(({ item }, offset) => {
        const index = props.startIndex + offset;
        const confirming = props.pendingArchiveId === item.threadId;
        return <li className="lc-thread-sidebar-row" key={item.threadId}>
          <button
            ref={(element) => { if (element) props.rowRefs.set(item.threadId, element); else props.rowRefs.delete(item.threadId); }}
            id={`thread-${item.threadId}`}
            type="button"
            role="option"
            aria-selected={item.isSelected}
            aria-label={`${item.title}${item.displayStatus === "waiting_for_approval" ? ", awaiting approval" : ""}`}
            tabIndex={props.focusedIndex === index ? 0 : -1}
            className={`lc-thread-sidebar-thread${item.isSelected ? " lc-thread-sidebar-thread-selected" : ""}`}
            onFocus={() => props.onFocus(index)}
            onKeyDown={(event) => props.onKeyDown(event, index, item)}
            onClick={() => props.onSelect(item.threadId)}
          >
            <span className="lc-thread-sidebar-thread-title">{item.title}</span>
            {item.displayStatus === "waiting_for_approval" ? <span className="lc-thread-sidebar-status">Awaiting approval</span> : null}
            {item.displayStatus !== "idle" && item.displayStatus !== "waiting_for_approval" ? <span className={`lc-thread-sidebar-state lc-thread-sidebar-state-${item.displayStatus}`} aria-label={`Status: ${item.displayStatus.replaceAll("_", " ")}`} title={item.displayStatus.replaceAll("_", " ")} /> : null}
            {item.isUnread ? <span className="lc-thread-sidebar-unread" aria-label="Unread activity" title="Unread activity" /> : null}
            {item.isPinned ? <span className="lc-thread-sidebar-pin" aria-label="Pinned">◆</span> : null}
          </button>
          {props.archived && props.onUnarchive ? <button className="lc-thread-sidebar-archive" type="button" aria-label={`Unarchive ${item.title}`} onClick={() => { void props.onUnarchive?.(item.threadId); }}>Unarchive</button> : null}
          {!props.archived && props.onArchive ? confirming ? <span className="lc-thread-sidebar-confirm">
            <button type="button" aria-label={`Cancel archive for ${item.title}`} onClick={props.onCancelArchive}>Cancel</button>
            <button type="button" aria-label={`Confirm archive for ${item.title}`} onClick={() => { void props.onConfirmArchive(item.threadId); }}>Archive</button>
          </span> : <button className="lc-thread-sidebar-archive" type="button" aria-label={`Archive ${item.title}`} onClick={() => props.setPendingArchiveId(item.threadId)}>Archive</button> : null}
        </li>;
      })}
    </ul>
  </section>;
}

function matches(
  item: ThreadSidebarItem,
  query: string,
  statusFilter: ThreadSidebarDisplayStatus | "all",
): boolean {
  return (statusFilter === "all" || item.displayStatus === statusFilter) &&
    (!query || item.title.toLocaleLowerCase().includes(query));
}
