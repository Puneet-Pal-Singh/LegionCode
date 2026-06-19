import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";
import type { SidebarContentTab } from "./useWorkspaceState";
import { WorkspaceAddMenu } from "./WorkspaceAddMenu";
import { WorkspaceTabStrip } from "./WorkspaceTabStrip";

interface WorkspaceSurfaceHeaderProps {
  id?: string;
  ariaLabel: string;
  variant: "sidebar" | "fullscreen";
  reviewActive: boolean;
  contentTabs: SidebarContentTab[];
  activeContentTabId: string | null;
  onSelectReview: () => void;
  onSelectContent: (id: string) => void;
  onCloseReview?: () => void;
  onCloseContent: (id: string) => void;
  onOpenFiles: () => void;
  onOpenChanges: () => void;
  trailingActions: ReactNode;
  width?: number;
  addTabLabel?: string;
}

export function WorkspaceSurfaceHeader({
  id,
  ariaLabel,
  variant,
  reviewActive,
  contentTabs,
  activeContentTabId,
  onSelectReview,
  onSelectContent,
  onCloseReview,
  onCloseContent,
  onOpenFiles,
  onOpenChanges,
  trailingActions,
  width,
  addTabLabel = "Add workspace tab",
}: WorkspaceSurfaceHeaderProps) {
  const isSidebar = variant === "sidebar";

  return (
    <header
      className={cn(
        "flex h-12 shrink-0 items-center border-b border-zinc-800 bg-[#111113] shadow-sm shadow-black/20",
        isSidebar && "fixed right-0 top-0 z-[60] border-l",
      )}
      style={width === undefined ? undefined : { width }}
    >
      <WorkspaceTabStrip
        id={id}
        ariaLabel={ariaLabel}
        reviewActive={reviewActive}
        contentTabs={contentTabs}
        activeContentTabId={activeContentTabId}
        onSelectReview={onSelectReview}
        onSelectContent={onSelectContent}
        onCloseReview={onCloseReview}
        onCloseContent={onCloseContent}
        size={variant}
      >
        <WorkspaceAddMenu
          align={isSidebar ? "right" : "left"}
          triggerLabel={addTabLabel}
          triggerClassName={isSidebar ? "p-1.5" : undefined}
          onOpenFiles={onOpenFiles}
          onOpenChanges={onOpenChanges}
        />
      </WorkspaceTabStrip>

      <div className="relative flex shrink-0 items-center gap-0.5 px-1.5">
        {trailingActions}
      </div>
    </header>
  );
}
