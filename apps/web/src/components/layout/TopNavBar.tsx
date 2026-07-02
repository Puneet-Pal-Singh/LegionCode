import { motion } from "framer-motion";
import { FileDiff, PanelLeftOpen, PanelRight } from "lucide-react";
import { OpenDropdown } from "../navigation/OpenDropdown";
import { GitHubLoginButton } from "../auth/GitHubLoginButton";
import { ChatHeaderMenu } from "../chat/ChatHeaderMenu";
import type { AgentSession } from "../../types/session";
import type { Repository } from "../../services/GitHubService";
import { TopEnvironmentSummary } from "../navigation/TopEnvironmentSummary";

interface TopNavBarProps {
  onOpenIde?: (ide: string) => void;
  onReview?: () => void;
  isSidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  isRightSidebarOpen?: boolean;
  rightSidebarWidth?: number;
  onToggleRightSidebar?: () => void;
  threadTitle?: string;
  taskTitle?: string;
  activeSession?: AgentSession | null;
  onRenameSession?: (title: string) => Promise<void>;
  onPinSession?: () => Promise<void>;
  onUnpinSession?: () => Promise<void>;
  onArchiveSession?: () => Promise<void>;
  isAuthenticated?: boolean;
  onConnectGitHub?: () => void;
  environmentSummary?: {
    sessionId: string;
    runId: string;
    repo: Repository | null;
    branch: string;
    enabled?: boolean;
    onBranchChange: (branch: string) => void;
    onOpenChanges: () => void;
    onOpenCommit: () => void;
  };
}

export function TopNavBar(props: TopNavBarProps) {
  return (
    <motion.header
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="h-12 bg-[#0c0c0e] border-b border-[#1a1a1a] flex items-center justify-between px-3 shrink-0 z-50 shadow-sm shadow-black/20"
    >
      <TopNavLeft {...props} />
      <div className="flex-1" />
      <TopNavActions {...props} />
    </motion.header>
  );
}

function TopNavLeft({
  isSidebarOpen,
  onToggleSidebar,
  taskTitle,
  activeSession,
  onRenameSession,
  onPinSession,
  onUnpinSession,
  onArchiveSession,
}: Pick<
  TopNavBarProps,
  | "isSidebarOpen"
  | "onToggleSidebar"
  | "taskTitle"
  | "activeSession"
  | "onRenameSession"
  | "onPinSession"
  | "onUnpinSession"
  | "onArchiveSession"
>) {
  return (
    <div className="flex items-center gap-3">
      {!isSidebarOpen ? (
        <motion.button
          onClick={onToggleSidebar}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-200"
          title="Open sidebar"
        >
          <PanelLeftOpen size={16} />
        </motion.button>
      ) : null}
      {taskTitle ? (
        <span className="text-sm font-medium text-white">{taskTitle}</span>
      ) : null}
      <ChatHeaderMenu
        session={activeSession ?? null}
        onRename={onRenameSession ?? (async () => undefined)}
        onPin={onPinSession ?? (async () => undefined)}
        onUnpin={onUnpinSession ?? (async () => undefined)}
        onArchive={onArchiveSession ?? (async () => undefined)}
      />
    </div>
  );
}

function TopNavActions({
  onOpenIde,
  onReview,
  isRightSidebarOpen = false,
  rightSidebarWidth = 0,
  onToggleRightSidebar,
  isAuthenticated = false,
  onConnectGitHub,
  environmentSummary,
}: Pick<
  TopNavBarProps,
  | "onOpenIde"
  | "onReview"
  | "isRightSidebarOpen"
  | "rightSidebarWidth"
  | "onToggleRightSidebar"
  | "isAuthenticated"
  | "onConnectGitHub"
  | "environmentSummary"
>) {
  return (
    <div
      data-testid="top-nav-actions"
      className="flex items-center gap-2 transition-[margin] duration-150"
      style={{ marginRight: isRightSidebarOpen ? rightSidebarWidth : 0 }}
    >
      {!isAuthenticated && onConnectGitHub ? (
        <GitHubLoginButton
          onClick={onConnectGitHub}
          size="sm"
          variant="secondary"
        />
      ) : null}
      <OpenDropdown onSelect={onOpenIde} disabled={!onOpenIde} />
      {environmentSummary ? (
        <TopEnvironmentSummary {...environmentSummary} />
      ) : null}
      {!isRightSidebarOpen ? (
        <ReviewControls
          onReview={onReview}
          onToggleRightSidebar={onToggleRightSidebar}
        />
      ) : null}
    </div>
  );
}

function ReviewControls({
  onReview,
  onToggleRightSidebar,
}: {
  onReview?: () => void;
  onToggleRightSidebar?: () => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-0.5">
      <motion.button
        onClick={onReview}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        disabled={!onReview}
        aria-label="Review"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-zinc-400 transition-all hover:bg-zinc-900 hover:text-white disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
        title={onReview ? "Open review panel" : "Review is not available yet"}
      >
        <FileDiff size={15} />
      </motion.button>
      <motion.button
        onClick={onToggleRightSidebar}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        disabled={!onToggleRightSidebar}
        aria-label="Toggle right sidebar"
        className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
        title="Toggle right sidebar"
      >
        <PanelRight size={17} />
      </motion.button>
    </div>
  );
}
