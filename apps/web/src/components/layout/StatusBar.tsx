import { motion } from "framer-motion";
import { cn } from "@legioncode/client-ui";

interface StatusBarProps {
  activeTab?: "local" | "worktree";
  onTabChange?: (tab: "local" | "worktree") => void;
  branchName?: string;
  onUpgrade?: () => void;
}

export function StatusBar({
  activeTab = "local",
  onTabChange,
  branchName = "main",
  onUpgrade,
}: StatusBarProps) {
  return (
    <footer className="h-9 bg-[#0c0c0e] border-t border-[#1a1a1a] flex items-center justify-between px-4 shrink-0">
      {/* Left: Upgrade Button */}
      <motion.button
        onClick={onUpgrade}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className="text-xs font-medium text-zinc-400 hover:text-white transition-colors"
      >
        Upgrade
      </motion.button>

      {/* Center: Tab Switcher */}
      <div className="flex items-center bg-zinc-900/50 rounded-lg p-0.5">
        <TabButton
          label="Local"
          isActive={activeTab === "local"}
          onClick={() => onTabChange?.("local")}
        />
        <TabButton
          label="Worktree"
          isActive={activeTab === "worktree"}
          onClick={() => onTabChange?.("worktree")}
        />
      </div>

      {/* Right: Branch Indicator */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-zinc-600"
        >
          <circle cx="12" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <circle cx="18" cy="6" r="3" />
          <path d="M6 9v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9" />
        </svg>
        <span className="font-mono">{branchName}</span>
      </div>
    </footer>
  );
}

interface TabButtonProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
}

function TabButton({ label, isActive, onClick }: TabButtonProps) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className={cn(
        "px-3 py-1 text-xs font-medium rounded-md transition-all duration-150",
        isActive
          ? "text-white bg-zinc-800"
          : "text-zinc-500 hover:text-zinc-300",
      )}
    >
      {label}
    </motion.button>
  );
}
