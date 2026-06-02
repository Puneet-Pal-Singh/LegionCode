import { motion } from "framer-motion";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  FileDiff,
  Folder,
  GitCommitHorizontal,
  GitBranch,
  Maximize2,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import type { TabType } from "./useWorkspaceState";

const REVIEW_COMMIT_ENTRY_POINT_ENABLED = false;

interface SidebarHeaderProps {
  isViewingContent: boolean;
  activeTab: TabType;
  changesCount: number;
  hasPendingApproval?: boolean;
  onBack: () => void;
  onTabChange: (tab: TabType) => void;
  onCommit?: () => void;
  onExpand?: () => void;
}

export function SidebarHeader({
  isViewingContent,
  activeTab,
  changesCount,
  hasPendingApproval = false,
  onBack,
  onTabChange,
  onCommit,
  onExpand,
}: SidebarHeaderProps) {
  return (
    <div className="h-10 border-b ui-muted-divider flex items-center justify-between px-3 bg-transparent shrink-0">
      {isViewingContent ? (
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-xs font-semibold text-zinc-400 transition-colors hover:text-white"
        >
          <ArrowLeft size={14} />
          Back
        </button>
      ) : activeTab === "review" ? (
        <SidebarSurfaceControls
          activeTab={activeTab}
          changesCount={changesCount}
          hasPendingApproval={hasPendingApproval}
          onTabChange={onTabChange}
          onCommit={onCommit}
          onExpand={onExpand}
        />
      ) : (
        <SidebarSurfaceControls
          activeTab={activeTab}
          changesCount={changesCount}
          hasPendingApproval={hasPendingApproval}
          onTabChange={onTabChange}
          onCommit={onCommit}
          onExpand={onExpand}
        />
      )}
    </div>
  );
}

function SidebarSurfaceControls({
  activeTab,
  changesCount,
  hasPendingApproval,
  onTabChange,
  onCommit,
  onExpand,
}: {
  activeTab: TabType;
  changesCount: number;
  hasPendingApproval: boolean;
  onTabChange: (tab: TabType) => void;
  onCommit?: () => void;
  onExpand?: () => void;
}) {
  return (
    <>
      <div className="flex h-full gap-1.5">
        <SidebarTabButton
          activeTab={activeTab}
          tab="review"
          label="Review"
          icon={<FileDiff size={14} />}
          count={changesCount}
          onTabChange={onTabChange}
        />
        <SidebarTabButton
          activeTab={activeTab}
          tab="changes"
          label="File changes"
          icon={<GitBranch size={14} />}
          count={changesCount}
          onTabChange={onTabChange}
        />
        <SidebarTabButton
          activeTab={activeTab}
          tab="files"
          label="Files"
          icon={<Folder size={14} />}
          onTabChange={onTabChange}
        />
      </div>
      <div className="flex items-center gap-1">
        {hasPendingApproval ? (
          <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
            Approval
          </span>
        ) : null}
        {/* TODO: Set REVIEW_COMMIT_ENTRY_POINT_ENABLED true after commit flow reliability is production-ready. */}
        {REVIEW_COMMIT_ENTRY_POINT_ENABLED ? (
          <HeaderIconButton
            title="Git actions"
            onClick={onCommit}
            disabled={!onCommit}
            className="hover:text-emerald-300"
          >
            <GitCommitHorizontal size={15} />
          </HeaderIconButton>
        ) : null}
        <HeaderIconButton
          title="Fullscreen review"
          onClick={onExpand}
          disabled={!onExpand}
        >
          <Maximize2 size={15} />
        </HeaderIconButton>
      </div>
    </>
  );
}

function HeaderIconButton({
  title,
  onClick,
  disabled = false,
  className,
  children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent",
        className,
      )}
      title={title}
    >
      {children}
    </button>
  );
}

function SidebarTabButton({
  activeTab,
  tab,
  label,
  icon,
  count,
  onTabChange,
}: {
  activeTab: TabType;
  tab: TabType;
  label: string;
  icon: ReactNode;
  count?: number;
  onTabChange: (tab: TabType) => void;
}) {
  const isActive = activeTab === tab;

  return (
    <button
      type="button"
      onClick={() => onTabChange(tab)}
      className={cn(
        "relative flex h-full items-center gap-1.5 px-1.5 text-xs font-semibold uppercase tracking-wide transition-colors",
        isActive ? "text-white" : "text-zinc-500 hover:text-zinc-300",
      )}
    >
      <span className="text-zinc-500">{icon}</span>
      <span>{label}</span>
      {count ? (
        <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
          {count}
        </span>
      ) : null}
      {isActive && (
        <motion.div
          layoutId="activeTab"
          className="absolute bottom-0 left-1 right-1 h-0.5 bg-zinc-400"
        />
      )}
    </button>
  );
}
