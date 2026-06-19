import { useCallback, useRef, useState, type ReactNode } from "react";
import { FileDiff, Folder, Maximize2, PanelRight, Plus, X } from "lucide-react";
import { cn } from "../../../lib/utils";
import { FileChangesIcon } from "../../sidebar/FileChangesIcon";
import { FileTypeIcon } from "../../ui/FileTypeIcon";
import type { SidebarContentTab } from "./useWorkspaceState";
import { useOutsideDismiss } from "../../../hooks/useOutsideDismiss";

interface SidebarHeaderProps {
  sidebarWidth: number;
  isViewingContent: boolean;
  contentTabs: SidebarContentTab[];
  activeContentTabId: string | null;
  onSelectReview: () => void;
  onSelectContent: (id: string) => void;
  onCloseReview: () => void;
  onCloseContent: (id: string) => void;
  onOpenFiles: () => void;
  onOpenChanges: () => void;
  onExpand?: () => void;
  onCloseSidebar: () => void;
}

export function SidebarHeader({
  sidebarWidth,
  isViewingContent,
  contentTabs,
  activeContentTabId,
  onSelectReview,
  onSelectContent,
  onCloseReview,
  onCloseContent,
  onOpenFiles,
  onOpenChanges,
  onExpand,
  onCloseSidebar,
}: SidebarHeaderProps) {
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const closeAddMenu = useCallback(() => setIsAddMenuOpen(false), []);
  useOutsideDismiss(addMenuRef, isAddMenuOpen, closeAddMenu);

  return (
    <header
      className="fixed right-0 top-0 z-[60] flex h-12 items-center border-b border-l border-zinc-800 bg-[#111113] shadow-sm shadow-black/20"
      style={{ width: sidebarWidth }}
    >
      <div
        role="tablist"
        aria-label="Right sidebar tabs"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-hide"
      >
        <SidebarTab
          label="Review"
          icon={<FileDiff size={15} />}
          active={!isViewingContent}
          onSelect={onSelectReview}
          onClose={onCloseReview}
        />
        {contentTabs.map((tab) => (
          <SidebarTab
            key={tab.id}
            label={formatContentTitle(tab.path)}
            icon={<FileTypeIcon path={tab.path} size={15} />}
            active={isViewingContent && activeContentTabId === tab.id}
            onSelect={() => onSelectContent(tab.id)}
            onClose={() => onCloseContent(tab.id)}
          />
        ))}
      </div>

      <div
        ref={addMenuRef}
        className="relative flex shrink-0 items-center gap-0.5 px-1.5"
      >
        <IconButton
          label="Add sidebar tab"
          onClick={() => setIsAddMenuOpen((previous) => !previous)}
        >
          <Plus size={17} />
        </IconButton>
        {isAddMenuOpen ? (
          <div
            role="menu"
            className="absolute right-20 top-9 z-20 w-44 rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
          >
            <MenuButton
              label="Files"
              icon={<Folder size={15} />}
              onClick={() => {
                onOpenFiles();
                setIsAddMenuOpen(false);
              }}
            />
            <MenuButton
              label="File changes"
              icon={<FileChangesIcon />}
              onClick={() => {
                onOpenChanges();
                setIsAddMenuOpen(false);
              }}
            />
          </div>
        ) : null}
        <IconButton
          label="Fullscreen review"
          onClick={onExpand}
          disabled={!onExpand}
        >
          <Maximize2 size={15} />
        </IconButton>
        <IconButton label="Close right sidebar" onClick={onCloseSidebar} active>
          <PanelRight size={17} />
        </IconButton>
      </div>
    </header>
  );
}

function SidebarTab({
  label,
  icon,
  active,
  onSelect,
  onClose,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      className={cn(
        "group my-1 ml-1 flex h-8 max-w-56 shrink-0 items-center rounded-xl",
        active
          ? "bg-[#242426] text-zinc-100"
          : "text-zinc-500 hover:bg-zinc-900/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 text-sm transition-colors hover:text-zinc-100"
      >
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        className="mr-1 rounded p-1 text-zinc-600 opacity-0 transition-all hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100 focus:opacity-100"
        aria-label={`Close ${label} tab`}
      >
        <X size={13} />
      </button>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled = false,
  active = false,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md p-1.5 transition-colors disabled:cursor-not-allowed disabled:text-zinc-700",
        active
          ? "bg-zinc-800 text-white"
          : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200",
      )}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function MenuButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white"
    >
      {icon}
      {label}
    </button>
  );
}

function formatContentTitle(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
