import { FileDiff, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { FileTypeIcon } from "../../ui/FileTypeIcon";
import type { SidebarContentTab } from "./useWorkspaceState";

interface WorkspaceTabStripProps {
  id?: string;
  ariaLabel: string;
  reviewActive: boolean;
  contentTabs: SidebarContentTab[];
  activeContentTabId: string | null;
  onSelectReview: () => void;
  onSelectContent: (id: string) => void;
  onCloseContent: (id: string) => void;
  onCloseReview?: () => void;
  size?: "sidebar" | "fullscreen";
  children?: ReactNode;
}

export function WorkspaceTabStrip({
  id,
  ariaLabel,
  reviewActive,
  contentTabs,
  activeContentTabId,
  onSelectReview,
  onSelectContent,
  onCloseContent,
  onCloseReview,
  size = "sidebar",
  children,
}: WorkspaceTabStripProps) {
  return (
    <div
      id={id}
      role="tablist"
      aria-label={ariaLabel}
      className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-hide"
    >
      <WorkspaceTab
        label="Review"
        icon={<FileDiff size={15} />}
        active={reviewActive}
        leading
        size={size}
        onSelect={onSelectReview}
        onClose={onCloseReview}
      />
      {contentTabs.map((tab) => (
        <WorkspaceTab
          key={tab.id}
          label={formatContentTitle(tab.path)}
          icon={<FileTypeIcon path={tab.path} size={15} />}
          active={!reviewActive && activeContentTabId === tab.id}
          size={size}
          onSelect={() => onSelectContent(tab.id)}
          onClose={() => onCloseContent(tab.id)}
        />
      ))}
      {children}
    </div>
  );
}

function WorkspaceTab({
  label,
  icon,
  active,
  leading = false,
  size,
  onSelect,
  onClose,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  leading?: boolean;
  size: "sidebar" | "fullscreen";
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex max-w-56 shrink-0 items-center rounded-xl",
        size === "fullscreen" ? "my-1.5 h-9" : "my-1 h-8",
        leading ? (size === "fullscreen" ? "ml-1" : "ml-4") : "ml-1",
        active
          ? "bg-[#242426] text-zinc-100"
          : "text-zinc-500 hover:bg-zinc-900/60",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 text-sm transition-colors hover:text-zinc-100"
      >
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-600 text-zinc-950 opacity-0 transition-all duration-150 hover:bg-zinc-400 hover:text-black group-hover:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          aria-label={`Close ${label} tab`}
        >
          <X size={14} strokeWidth={2.5} />
        </button>
      ) : null}
    </div>
  );
}

function formatContentTitle(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
