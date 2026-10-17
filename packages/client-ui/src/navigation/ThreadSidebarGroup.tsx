import { AnimatePresence, motion } from "framer-motion";
import {
  Archive,
  ArchiveRestore,
  Circle,
  Edit2,
  Folder,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Plus,
  Trash2,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ThreadSidebarDisplayStatus, ThreadSidebarItem } from "@legioncode/sdk";

export interface ThreadSidebarEntry {
  item: ThreadSidebarItem;
  workspaceLabel: string;
}

type WorkspaceSelectionId = string;

export interface ThreadSidebarGroupProps {
  label: string;
  workspaceSelectionId?: WorkspaceSelectionId;
  expanded?: boolean;
  onToggle?: () => void;
  placement?: "local" | "hosted" | null;
  entries: ThreadSidebarEntry[];
  startIndex: number;
  focusedIndex: number;
  rowRefs: Map<string, HTMLButtonElement>;
  pendingArchiveId: string | null;
  onFocus: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number, item: ThreadSidebarItem) => void;
  onSelect: (selectionId: string) => void;
  onArchive?: (selectionId: string) => void | Promise<void>;
  onUnarchive?: (selectionId: string) => void | Promise<void>;
  archived?: boolean;
  onConfirmArchive: (selectionId: string) => Promise<void>;
  onCancelArchive: () => void;
  setPendingArchiveId: (selectionId: string | null) => void;
  onCreate?: () => void;
  onRenameWorkspace?: (workspaceSelectionId: WorkspaceSelectionId, newLabel: string) => void | Promise<void>;
  onRemoveWorkspace?: (workspaceSelectionId: WorkspaceSelectionId) => void | Promise<void>;
  hasMore?: boolean;
  onShowMore?: () => void;
}

interface StatusVisual {
  icon: LucideIcon;
  className: string;
  kind: "icon" | "spinner";
}

const STATUS_VISUALS: Partial<Record<ThreadSidebarDisplayStatus, StatusVisual>> = {
  running: { icon: LoaderCircle, className: "animate-spin text-zinc-300", kind: "spinner" },
  paused: { icon: Pause, className: "text-zinc-500", kind: "icon" },
  failed: { icon: Circle, className: "fill-red-400 text-red-400", kind: "icon" },
  completed: { icon: Circle, className: "fill-sky-400 text-sky-400", kind: "icon" },
};

function getRelativeTime(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "--";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  return `${Math.floor(seconds / 604_800)}w`;
}

function StatusIndicator({ status }: { status: ThreadSidebarDisplayStatus }): React.ReactElement | null {
  const visual = STATUS_VISUALS[status];
  if (!visual) return null;
  const StatusIcon = visual.icon;
  const isNotification = status === "failed" || status === "completed";
  return (
    <span className="inline-flex size-4 items-center justify-center" aria-hidden="true">
      <StatusIcon
        data-testid={`task-status-${status}`}
        data-status-kind={visual.kind}
        className={`${isNotification ? "size-1.5" : "size-4"} ${visual.className}`}
      />
    </span>
  );
}

export function ThreadSidebarGroup(props: ThreadSidebarGroupProps): React.ReactElement {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState(props.label);
  const [isConfirmingWorkspaceRemoval, setIsConfirmingWorkspaceRemoval] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const workspaceSelectionId = props.workspaceSelectionId;

  useEffect(() => setDraftLabel(props.label), [props.label]);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
        setIsConfirmingWorkspaceRemoval(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!isConfirmingWorkspaceRemoval) return;
    const timer = window.setTimeout(() => setIsConfirmingWorkspaceRemoval(false), 4000);
    return () => window.clearTimeout(timer);
  }, [isConfirmingWorkspaceRemoval]);

  function confirmRename(): void {
    const trimmedLabel = draftLabel.trim();
    if (!trimmedLabel || trimmedLabel === props.label || !workspaceSelectionId) {
      setDraftLabel(props.label);
      setIsRenaming(false);
      return;
    }
    void props.onRenameWorkspace?.(workspaceSelectionId, trimmedLabel);
    setIsRenaming(false);
    setIsMenuOpen(false);
  }

  const FolderIcon = props.expanded ? FolderOpen : Folder;

  return (
    <section role="group" className="space-y-0.5" aria-label={props.label}>
      {workspaceSelectionId && props.onToggle ? (
      <div className="group/project grid h-9 grid-cols-[minmax(0,1fr)_auto] items-center rounded-lg transition hover:bg-zinc-800/35">
        <button
          type="button"
          onClick={props.onToggle}
          className="grid h-9 min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center rounded-lg text-left text-zinc-500 transition hover:text-zinc-200"
          aria-expanded={props.expanded}
          aria-label={`Toggle ${props.label}`}
        >
          <span className="flex size-8 items-center justify-center"><FolderIcon size={16} aria-hidden="true" /></span>
          {!isRenaming ? <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{props.label}</span> : null}
        </button>
        {isRenaming && workspaceSelectionId && props.onRenameWorkspace ? (
          <form
            className="flex min-w-0 items-center gap-1"
            onSubmit={(event) => { event.preventDefault(); confirmRename(); }}
            onClick={(event) => event.stopPropagation()}
          >
            <input
              autoFocus
              aria-label={`Rename ${props.label}`}
              value={draftLabel}
              onChange={(event) => setDraftLabel(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraftLabel(props.label);
                  setIsRenaming(false);
                }
              }}
              className="h-7 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none"
            />
            <button type="submit" disabled={!draftLabel.trim()} className="rounded px-1.5 py-1 text-[10px] font-medium text-zinc-300 hover:bg-zinc-800">Save</button>
            <button type="button" onClick={() => { setDraftLabel(props.label); setIsRenaming(false); }} className="rounded px-1.5 py-1 text-[10px] font-medium text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">Cancel</button>
          </form>
        ) : null}

        <div className="relative flex items-center" ref={menuRef}>
          {props.onCreate ? (
            <button type="button" aria-label={`New task in ${props.label}`} title={`New task in ${props.label}`} onClick={(event) => { event.stopPropagation(); props.onCreate?.(); }} className="rounded p-1.5 text-zinc-500 opacity-0 transition hover:bg-zinc-800/70 hover:text-zinc-200 focus-visible:opacity-100 group-hover/project:opacity-100">
              <Plus size={14} aria-hidden="true" />
            </button>
          ) : null}
          {workspaceSelectionId && (props.onRenameWorkspace || props.onRemoveWorkspace) ? (
            <>
              <button type="button" aria-label={`Workspace actions for ${props.label}`} title={`Actions for ${props.label}`} aria-haspopup="menu" aria-expanded={isMenuOpen} onClick={(event) => { event.stopPropagation(); setIsMenuOpen((open) => !open); setIsConfirmingWorkspaceRemoval(false); }} className="rounded p-1.5 text-zinc-500 opacity-0 transition hover:bg-zinc-800/70 hover:text-zinc-200 focus-visible:opacity-100 group-hover/project:opacity-100">
                <MoreHorizontal size={14} aria-hidden="true" />
              </button>
              <AnimatePresence>
                {isMenuOpen ? (
                  <motion.div initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} role="menu" className="ui-surface-popover absolute right-0 top-7 z-30 w-36 py-1">
                    {props.onRenameWorkspace ? (
                      <button type="button" role="menuitem" onClick={() => { setDraftLabel(props.label); setIsRenaming(true); setIsConfirmingWorkspaceRemoval(false); setIsMenuOpen(false); }} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-800">
                        <Edit2 size={12} className="text-zinc-500" aria-hidden="true" />Rename
                      </button>
                    ) : null}
                    {props.onRemoveWorkspace ? isConfirmingWorkspaceRemoval ? (
                      <div className="px-2.5 py-1.5" role="group" aria-label={`Confirm removal of ${props.label}`}>
                        <div className="mb-1.5 text-[10px] font-medium text-zinc-500">Confirm remove?</div>
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={() => setIsConfirmingWorkspaceRemoval(false)} className="flex-1 rounded border border-zinc-700 px-1.5 py-1 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800">Cancel</button>
                          <button type="button" onClick={() => { void props.onRemoveWorkspace?.(workspaceSelectionId); setIsConfirmingWorkspaceRemoval(false); setIsMenuOpen(false); }} className="flex-1 rounded border border-red-700/70 bg-red-950/40 px-1.5 py-1 text-[10px] font-semibold text-red-300 transition-colors hover:bg-red-900/40">Confirm</button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" role="menuitem" onClick={() => setIsConfirmingWorkspaceRemoval(true)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-950/40">
                        <Trash2 size={12} className="text-red-300" aria-hidden="true" />Remove
                      </button>
                    ) : null}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </>
          ) : null}
        </div>
      </div>
      ) : null}

      <AnimatePresence initial={false}>
        {props.expanded || !props.onToggle ? (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden">
            <ul role="group" aria-label={`${props.label} threads`} className="space-y-0.5">
              {props.entries.map(({ item }, offset) => {
                const index = props.startIndex + offset;
                const confirming = props.pendingArchiveId === item.selectionId;
                const relativeTime = getRelativeTime(item.updatedAt);
                return (
                  <li className="group relative" key={item.selectionId}>
                    <button
                      type="button"
                      ref={(element) => { if (element) props.rowRefs.set(item.selectionId, element); else props.rowRefs.delete(item.selectionId); }}
                      data-testid={`thread-${item.selectionId}`}
                      data-thread-id={item.threadId ?? undefined}
                      data-unread={item.isUnread ? "true" : "false"}
                      id={`thread-${item.selectionId}`}
                      role="option"
                      aria-selected={item.isSelected}
                      aria-label={`${item.title}${item.displayStatus === "waiting_for_approval" ? ", awaiting approval" : ""}`}
                      tabIndex={props.focusedIndex === index ? 0 : -1}
                      onFocus={() => props.onFocus(index)}
                      onKeyDown={(event) => props.onKeyDown(event, index, item)}
                      onClick={() => props.onSelect(item.selectionId)}
                      className={`h-[34px] w-full rounded-md text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${item.isSelected ? "bg-zinc-800/55 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800/35 hover:text-zinc-100"} ${confirming ? "pr-28" : ""}`}
                    >
                      <div className="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-1.5 pl-8 pr-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`min-w-0 truncate text-sm ${item.isSelected ? "font-medium" : "font-normal"}`} title={item.title}>{item.title}</span>
                          {item.displayStatus === "waiting_for_approval" ? <span data-testid="task-status-label-needs_approval" className="shrink-0 rounded-full bg-emerald-900/70 px-2 py-0.5 text-[10px] font-medium leading-4 text-emerald-300">Awaiting approval</span> : null}
                        </div>
                        <div className={`flex shrink-0 items-center justify-end gap-1.5 text-xs transition-[margin] ${props.onArchive && !confirming ? "group-hover:mr-6" : ""}`}>
                          {item.isUnread ? <span className="font-medium text-amber-300" aria-label="Unread activity" title="Unread activity">●</span> : null}
                          <span className="w-0 overflow-hidden whitespace-nowrap text-zinc-500 opacity-0 transition-[width,opacity] group-hover:w-auto group-hover:opacity-100 group-focus-within:w-auto group-focus-within:opacity-100" title={relativeTime}>{relativeTime}</span>
                          <StatusIndicator status={item.displayStatus} />
                        </div>
                      </div>
                    </button>
                    {props.archived && props.onUnarchive ? (
                      <button type="button" data-testid="task-archive-action" aria-label={`Unarchive ${item.title}`} onClick={() => { void props.onUnarchive?.(item.selectionId); }} className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded p-1.5 text-zinc-500 opacity-0 transition hover:bg-zinc-800/70 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100">
                        <ArchiveRestore size={14} aria-hidden="true" />
                      </button>
                    ) : !confirming && props.onArchive ? (
                      <button type="button" data-testid="task-archive-action" aria-label={`Archive ${item.title}`} title={`Archive ${item.title}`} onClick={() => props.setPendingArchiveId(item.selectionId)} className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded p-1.5 text-zinc-500 opacity-0 transition hover:bg-zinc-800/70 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100">
                        <Archive size={14} aria-hidden="true" />
                      </button>
                    ) : null}
                    {confirming ? (
                      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                        <button type="button" aria-label={`Cancel archive for ${item.title}`} onClick={(event) => { event.stopPropagation(); props.onCancelArchive(); }} className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800">Cancel</button>
                        <button type="button" aria-label={`Confirm archive for ${item.title}`} onClick={(event) => { event.stopPropagation(); void props.onConfirmArchive(item.selectionId); }} className="rounded border border-red-700/70 bg-red-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-300 transition-colors hover:bg-red-900/40">Confirm</button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {props.hasMore ? (
              <button
                type="button"
                onClick={props.onShowMore}
                className="flex h-7 items-center gap-1.5 pl-8 pr-2 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300"
              >
                <span>Show more</span>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
