import { motion } from "framer-motion";
import { FileDiff, PanelLeftOpen, PanelRight } from "lucide-react";
import { OpenDropdown } from "../navigation/OpenDropdown";
import { GitHubLoginButton } from "../auth/GitHubLoginButton";

interface TopNavBarProps {
  onOpenIde?: (ide: string) => void;
  onReview?: () => void;
  isSidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  isRightSidebarOpen?: boolean;
  onToggleRightSidebar?: () => void;
  threadTitle?: string;
  taskTitle?: string;
  isAuthenticated?: boolean;
  onConnectGitHub?: () => void;
}

export function TopNavBar({
  onOpenIde,
  onReview,
  isSidebarOpen = true,
  onToggleSidebar,
  isRightSidebarOpen = false,
  onToggleRightSidebar,
  taskTitle,
  isAuthenticated = false,
  onConnectGitHub,
}: TopNavBarProps) {
  return (
    <motion.header
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="h-10 bg-[#0c0c0e] border-b border-[#1a1a1a] flex items-center justify-between px-3 shrink-0 z-50 shadow-sm shadow-black/20"
    >
      {/* Left Section - Sidebar Toggle and Task Title */}
      <div className="flex items-center gap-3">
        {!isSidebarOpen && (
          <motion.button
            onClick={onToggleSidebar}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="p-1.5 text-zinc-400 hover:text-zinc-200 transition-colors rounded-md hover:bg-zinc-800/50"
            title="Open sidebar"
          >
            <PanelLeftOpen size={16} />
          </motion.button>
        )}
        {/* Task Title */}
        {taskTitle && (
          <span className="text-sm font-medium text-white">{taskTitle}</span>
        )}
      </div>

      {/* Center Section - Spacer */}
      <div className="flex-1" />

      {/* Right Section */}
      <div className="flex items-center gap-3">
        {!isAuthenticated && onConnectGitHub && (
          <GitHubLoginButton
            onClick={onConnectGitHub}
            size="sm"
            variant="secondary"
          />
        )}
        <OpenDropdown onSelect={onOpenIde} disabled={!onOpenIde} />
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-0.5">
          <motion.button
            onClick={onReview}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            disabled={!onReview}
            aria-label="Review"
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent ${
              isRightSidebarOpen
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-white"
            }`}
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
            className={`rounded-md p-1.5 transition-colors disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent ${
              isRightSidebarOpen
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
            title="Toggle right sidebar"
          >
            <PanelRight size={17} />
          </motion.button>
        </div>
      </div>
    </motion.header>
  );
}
