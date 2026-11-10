import type { ReactNode, Ref } from "react";
import { cn } from "../classnames.js";
import type { WorkspaceContentTab } from "./WorkspaceTabStrip.js";
import { WorkspaceAddMenu } from "./WorkspaceAddMenu.js";
import { WorkspaceTabStrip } from "./WorkspaceTabStrip.js";

interface WorkspaceSurfaceHeaderProps {
  headerRef?: Ref<HTMLElement>;
  id?: string;
  ariaLabel: string;
  variant: "sidebar" | "fullscreen";
  reviewActive: boolean;
  contentTabs: WorkspaceContentTab[];
  activeContentTabId: string | null;
  onSelectReview: () => void;
  onSelectContent: (id: string) => void;
  onCloseReview?: () => void;
  onCloseContent: (id: string) => void;
  onOpenFiles: () => void;
  onOpenChanges: () => void;
  trailingActions: ReactNode;
  width?: number | string;
  addTabLabel?: string;
  position?: "fixed" | "inline";
}

export function WorkspaceSurfaceHeader({
  headerRef,
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
  position = "fixed",
}: WorkspaceSurfaceHeaderProps) {
  const isSidebar = variant === "sidebar";

  return (
    <header
      ref={headerRef}
      className={cn(
        "relative z-[80] flex h-12 shrink-0 items-center border-b border-zinc-800 bg-[#111113] shadow-sm shadow-black/20",
        isSidebar &&
          position === "fixed" &&
          "fixed right-0 top-0 z-[60] border-l",
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
      />

      <div className="relative flex shrink-0 items-center gap-0.5 px-1.5">
        <WorkspaceAddMenu
          align="right"
          triggerLabel={addTabLabel}
          triggerClassName="p-1.5"
          onOpenFiles={onOpenFiles}
          onOpenChanges={onOpenChanges}
        />
        {trailingActions}
      </div>
    </header>
  );
}
