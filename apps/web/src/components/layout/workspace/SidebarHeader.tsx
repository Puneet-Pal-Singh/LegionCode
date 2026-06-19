import type { ReactNode } from "react";
import { Maximize2, PanelRight } from "lucide-react";
import { cn } from "../../../lib/utils";
import type { SidebarContentTab } from "./useWorkspaceState";
import { WorkspaceAddMenu } from "./WorkspaceAddMenu";
import { WorkspaceTabStrip } from "./WorkspaceTabStrip";

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
  return (
    <header
      className="fixed right-0 top-0 z-[60] flex h-12 items-center border-b border-l border-zinc-800 bg-[#111113] shadow-sm shadow-black/20"
      style={{ width: sidebarWidth }}
    >
      <WorkspaceTabStrip
        ariaLabel="Right sidebar tabs"
        reviewActive={!isViewingContent}
        contentTabs={contentTabs}
        activeContentTabId={activeContentTabId}
        onSelectReview={onSelectReview}
        onSelectContent={onSelectContent}
        onCloseReview={onCloseReview}
        onCloseContent={onCloseContent}
      />

      <div className="relative flex shrink-0 items-center gap-0.5 px-1.5">
        <WorkspaceAddMenu
          align="right"
          triggerLabel="Add sidebar tab"
          triggerClassName="p-1.5"
          onOpenFiles={onOpenFiles}
          onOpenChanges={onOpenChanges}
        />
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
