import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Edit2,
  Folder,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Pin,
  PinOff,
  Plus,
  Trash2,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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
  onPin?: (selectionId: string) => void | Promise<void>;
  onUnpin?: (selectionId: string) => void | Promise<void>;
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
  failed: { icon: AlertCircle, className: "text-red-400", kind: "icon" },
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
  const isNotification = status === "failed";
  return (
    <span className="inline-flex size-4 items-center justify-center" aria-hidden="true">
      <StatusIcon
        data-testid={`task-status-${status}`}
        data-status-kind={visual.kind}
        className={`${status === "failed" ? "size-4" : isNotification ? "size-1.5" : "size-4"} ${visual.className}`}
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
  const cancelRenameBlurRef = useRef(false);
  const renameFinalizedRef = useRef(false);
  const workspaceSelectionId = props.workspaceSelectionId;

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
    if (renameFinalizedRef.current) return;
    renameFinalizedRef.current = true;
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
        {isRenaming && workspaceSelectionId && props.onRenameWorkspace ? (
          <input
            autoFocus
            aria-label={`Rename ${props.label}`}
            value={draftLabel}
            onBlur={() => {
              if (cancelRenameBlurRef.current) {
                cancelRenameBlurRef.current = false;
                return;
              }
              confirmRename();
            }}
            onChange={(event) => setDraftLabel(event.currentTarget.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") confirmRename();
              if (event.key === "Escape") {
                event.preventDefault();
                cancelRenameBlurRef.current = true;
                renameFinalizedRef.current = true;
                setDraftLabel(props.label);
                setIsRenaming(false);
              }
            }}
            className="h-7 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={props.onToggle}
            className="grid h-9 min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center rounded-lg text-left text-zinc-500 transition hover:text-zinc-200"
            aria-expanded={props.expanded}
            aria-label={`Toggle ${props.label}`}
          >
            <span className="flex size-8 items-center justify-center"><FolderIcon size={16} aria-hidden="true" /></span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{props.label}</span>
          </button>
        )}

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
                      <button type="button" role="menuitem" onClick={() => { cancelRenameBlurRef.current = false; renameFinalizedRef.current = false; setDraftLabel(props.label); setIsRenaming(true); setIsConfirmingWorkspaceRemoval(false); setIsMenuOpen(false); }} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-800">
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
              {props.entries.map(({ item, workspaceLabel }, offset) => {
                const index = props.startIndex + offset;
                const confirming = props.pendingArchiveId === item.selectionId;
                const relativeTime = getRelativeTime(item.updatedAt);
                const hasThreadActions = Boolean(
                  props.archived
                    ? props.onUnarchive
                    : props.onPin || props.onUnpin || props.onArchive,
                );
                return (
                  <ThreadSidebarRow
                    key={item.selectionId}
                    item={item}
                    workspaceLabel={workspaceLabel}
                    relativeTime={relativeTime}
                    index={index}
                    focusedIndex={props.focusedIndex}
                    confirming={confirming}
                    hasThreadActions={hasThreadActions}
                    onFocus={props.onFocus}
                    onKeyDown={props.onKeyDown}
                    onSelect={props.onSelect}
                    rowRefs={props.rowRefs}
                    onPin={props.onPin}
                    onUnpin={props.onUnpin}
                    onArchive={props.onArchive}
                    onUnarchive={props.onUnarchive}
                    archived={props.archived}
                    setPendingArchiveId={props.setPendingArchiveId}
                    onConfirmArchive={props.onConfirmArchive}
                    onCancelArchive={props.onCancelArchive}
                  />
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

interface ThreadSidebarRowProps {
  item: ThreadSidebarItem;
  workspaceLabel: string;
  relativeTime: string;
  index: number;
  focusedIndex: number;
  confirming: boolean;
  hasThreadActions: boolean;
  onFocus: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number, item: ThreadSidebarItem) => void;
  onSelect: (selectionId: string) => void;
  rowRefs: Map<string, HTMLButtonElement>;
  onPin?: (selectionId: string) => void | Promise<void>;
  onUnpin?: (selectionId: string) => void | Promise<void>;
  onArchive?: (selectionId: string) => void | Promise<void>;
  onUnarchive?: (selectionId: string) => void | Promise<void>;
  archived?: boolean;
  setPendingArchiveId: (selectionId: string | null) => void;
  onConfirmArchive: (selectionId: string) => Promise<void>;
  onCancelArchive: () => void;
}

function ThreadSidebarRow({
  item,
  workspaceLabel,
  relativeTime,
  index,
  focusedIndex,
  confirming,
  hasThreadActions,
  onFocus,
  onKeyDown,
  onSelect,
  rowRefs,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  archived,
  setPendingArchiveId,
  onConfirmArchive,
  onCancelArchive,
}: ThreadSidebarRowProps): React.ReactElement {
  const rowRef = useRef<HTMLLIElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [detailsPosition, setDetailsPosition] = useState<{ left: number; top: number } | null>(null);
  const detailsId = `thread-details-${item.selectionId}`;
  const hideIndicatorCluster = hasThreadActions && !confirming;

  useLayoutEffect(() => {
    if (!isDetailsOpen) return;
    const updatePosition = (): void => {
      const rect = rowRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 16);
      const height = detailsRef.current?.getBoundingClientRect().height ?? 72;
      const left = rect.right + 8 + width <= window.innerWidth - 8
        ? rect.right + 8
        : Math.max(8, rect.left - width - 8);
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8));
      setDetailsPosition({ left, top });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setIsDetailsOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isDetailsOpen]);

  const pinAction = item.isPinned ? onUnpin : onPin;
  const PinActionIcon = item.isPinned ? PinOff : Pin;

  return (
    <li
      ref={rowRef}
      className="group relative"
      onMouseEnter={() => setIsDetailsOpen(true)}
      onMouseLeave={() => setIsDetailsOpen(false)}
      onFocusCapture={() => setIsDetailsOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDetailsOpen(false);
        }
      }}
    >
      <button
        type="button"
        ref={(element) => {
          if (element) rowRefs.set(item.selectionId, element);
          else rowRefs.delete(item.selectionId);
        }}
        data-testid={`thread-${item.selectionId}`}
        data-thread-id={item.threadId ?? undefined}
        data-unread={item.isUnread ? "true" : "false"}
        id={`thread-${item.selectionId}`}
        role="option"
        aria-selected={item.isSelected}
        aria-describedby={isDetailsOpen ? detailsId : undefined}
        aria-label={`${item.title}${item.displayStatus === "waiting_for_approval" ? ", awaiting approval" : item.displayStatus === "failed" ? ", failed" : ""}${item.isUnread ? ", unread activity" : ""}`}
        tabIndex={focusedIndex === index ? 0 : -1}
        onFocus={() => onFocus(index)}
        onKeyDown={(event) => onKeyDown(event, index, item)}
        onClick={() => onSelect(item.selectionId)}
        className={`relative h-[34px] w-full rounded-md text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${item.isSelected ? "bg-zinc-800/55 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800/35 hover:text-zinc-100"} ${confirming ? "pr-28" : ""}`}
      >
        <div className={`flex min-w-0 items-center gap-2 pl-8 pr-2 ${hasThreadActions ? "pr-14" : ""}`}>
          <div className="flex min-w-0 items-center gap-2">
            <span className={`min-w-0 truncate text-sm ${item.isSelected ? "font-medium" : "font-normal"}`}>
              {item.title}
            </span>
            {item.displayStatus === "waiting_for_approval" ? (
              <span
                data-testid="task-status-label-needs_approval"
                className="shrink-0 rounded-full bg-emerald-900/70 px-2 py-0.5 text-[10px] font-medium leading-4 text-emerald-300"
              >
                Awaiting approval
              </span>
            ) : null}
          </div>
        </div>
        <div
          className={`absolute right-2 top-1/2 flex -translate-y-1/2 items-center justify-end gap-1.5 text-xs transition-opacity ${hideIndicatorCluster ? "group-hover:opacity-0 group-focus-within:opacity-0" : ""}`}
        >
            {item.isUnread ? (
              <span className="inline-flex size-4 items-center justify-center" aria-label="Unread activity" title="Unread activity">
                <span className="size-2 rounded-full bg-sky-400" />
              </span>
            ) : null}
            <StatusIndicator status={item.displayStatus} />
        </div>
      </button>

      {(!confirming && hasThreadActions) || (archived && onUnarchive) ? (
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {!archived && pinAction ? (
            <button
              type="button"
              aria-label={`${item.isPinned ? "Unpin" : "Pin"} ${item.title}`}
              title={`${item.isPinned ? "Unpin" : "Pin"} ${item.title}`}
              onClick={() => { void pinAction(item.selectionId); }}
              className="grid size-6 place-items-center rounded p-1 text-zinc-500 transition hover:bg-zinc-700/70 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            >
              <PinActionIcon size={14} aria-hidden="true" />
            </button>
          ) : null}
          {archived && onUnarchive ? (
            <button
              type="button"
              data-testid="task-archive-action"
              aria-label={`Unarchive ${item.title}`}
              onClick={() => { void onUnarchive(item.selectionId); }}
              className="grid size-6 place-items-center rounded p-1 text-zinc-500 transition hover:bg-zinc-700/70 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            >
              <ArchiveRestore size={14} aria-hidden="true" />
            </button>
          ) : !confirming && onArchive ? (
            <button
              type="button"
              data-testid="task-archive-action"
              aria-label={`Archive ${item.title}`}
              title={`Archive ${item.title}`}
              onClick={() => setPendingArchiveId(item.selectionId)}
              className="grid size-6 place-items-center rounded p-1 text-zinc-500 transition hover:bg-zinc-700/70 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            >
              <Archive size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          <button
            type="button"
            aria-label={`Cancel archive for ${item.title}`}
            onClick={(event) => { event.stopPropagation(); onCancelArchive(); }}
            className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            aria-label={`Confirm archive for ${item.title}`}
            onClick={(event) => { event.stopPropagation(); void onConfirmArchive(item.selectionId); }}
            className="rounded border border-red-700/70 bg-red-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-300 transition-colors hover:bg-red-900/40"
          >
            Confirm
          </button>
        </div>
      ) : null}

      {isDetailsOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={detailsRef}
              id={detailsId}
              role="tooltip"
              className="pointer-events-none fixed z-[120] w-[360px] max-w-[calc(100vw-16px)] rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-3 shadow-2xl shadow-black/50 backdrop-blur"
              style={detailsPosition ?? { left: 0, top: 0, visibility: "hidden" }}
            >
              <div className="flex min-w-0 items-center justify-between gap-4">
                <div className="truncate text-sm font-medium text-zinc-100">{item.title}</div>
                <span className="shrink-0 text-xs text-zinc-400">
                  {relativeTime === "now" ? "just now" : `${relativeTime} ago`}
                </span>
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-zinc-400">
                <FolderOpen size={14} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{workspaceLabel}</span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </li>
  );
}
