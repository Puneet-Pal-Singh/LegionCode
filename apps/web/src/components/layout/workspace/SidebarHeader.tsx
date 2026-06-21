import type { ReactNode } from "react";
import { Maximize2, PanelRight } from "lucide-react";
import { cn } from "../../../lib/utils";
import type { SidebarContentTab } from "./useWorkspaceState";
import { WorkspaceSurfaceHeader } from "./WorkspaceSurfaceHeader";

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
    <WorkspaceSurfaceHeader
      variant="sidebar"
      width={sidebarWidth}
      ariaLabel="Right sidebar tabs"
      reviewActive={!isViewingContent}
      contentTabs={contentTabs}
      activeContentTabId={activeContentTabId}
      onSelectReview={onSelectReview}
      onSelectContent={onSelectContent}
      onCloseReview={onCloseReview}
      onCloseContent={onCloseContent}
      onOpenFiles={onOpenFiles}
      onOpenChanges={onOpenChanges}
      addTabLabel="Add sidebar tab"
      trailingActions={
        <>
          <IconButton
            label="Fullscreen review"
            onClick={onExpand}
            disabled={!onExpand}
          >
            <Maximize2 size={15} />
          </IconButton>
          <IconButton
            label="Close right sidebar"
            onClick={onCloseSidebar}
            active
          >
            <PanelRight size={17} />
          </IconButton>
        </>
      }
    />
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
