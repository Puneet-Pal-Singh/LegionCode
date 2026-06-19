import { useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, GitBranch, Loader2, Search } from "lucide-react";
import { useOutsideDismiss } from "../../hooks/useOutsideDismiss";
import { cn } from "../../lib/utils";

export interface BranchSelectorBranch {
  name: string;
  protected: boolean;
}

interface BranchSelectorProps {
  currentBranch: string;
  branches: BranchSelectorBranch[];
  isLoading?: boolean;
  onBranchSelect: (branch: string) => void;
  className?: string;
  placement?: "above" | "below";
}

export function BranchSelector({
  currentBranch,
  branches,
  isLoading = false,
  onBranchSelect,
  className,
  placement = "below",
}: BranchSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setIsOpen(false), []);
  useOutsideDismiss(rootRef, isOpen, close);

  return (
    <div ref={rootRef} className={cn("relative flex items-center", className)}>
      <BranchSelectorTrigger
        branch={currentBranch}
        isLoading={isLoading}
        isOpen={isOpen}
        onToggle={() => setIsOpen((current) => !current)}
      />
      <AnimatePresence>
        {isOpen ? (
          <BranchSelectorPanel
            currentBranch={currentBranch}
            branches={branches}
            isLoading={isLoading}
            onBranchSelect={(branch) => {
              onBranchSelect(branch);
              close();
            }}
            className={
              placement === "below"
                ? "left-0 top-full mt-2"
                : "bottom-full left-0 mb-2"
            }
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function BranchSelectorTrigger({
  branch,
  isLoading,
  isOpen,
  onToggle,
}: {
  branch: string;
  isLoading: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-zinc-500">
        <Loader2 size={12} className="animate-spin" />
        Loading...
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label="Select branch"
      aria-expanded={isOpen}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-800/50 hover:text-zinc-200",
        isOpen && "bg-zinc-800/50 text-zinc-200",
      )}
    >
      <GitBranch size={12} />
      <span className="max-w-40 truncate">{branch}</span>
      <ChevronDown
        size={12}
        className={cn("transition-transform", isOpen && "rotate-180")}
      />
    </button>
  );
}

interface BranchSelectorPanelProps {
  currentBranch: string;
  branches: BranchSelectorBranch[];
  isLoading?: boolean;
  onBranchSelect: (branch: string) => void;
  className?: string;
}

export function BranchSelectorPanel({
  currentBranch,
  branches,
  isLoading = false,
  onBranchSelect,
  className,
}: BranchSelectorPanelProps) {
  const [query, setQuery] = useState("");
  const visibleBranches = useMemo(
    () =>
      sortBranches(
        branches.filter((branch) =>
          branch.name.toLowerCase().includes(query.toLowerCase()),
        ),
        currentBranch,
      ),
    [branches, currentBranch, query],
  );
  return (
    <motion.div
      role="dialog"
      aria-label="Switch branch"
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      className={cn(
        "ui-surface-popover absolute z-50 w-80 overflow-hidden rounded-xl",
        className,
      )}
    >
      <div className="border-b border-zinc-800 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        Switch branch
      </div>
      <label className="relative block border-b border-zinc-800 p-2">
        <Search
          size={14}
          className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500"
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a branch..."
          autoFocus
          className="ui-input w-full py-2 pl-8 pr-3 text-xs"
        />
      </label>
      <BranchSelectorList
        branches={visibleBranches}
        currentBranch={currentBranch}
        isLoading={isLoading}
        onSelect={onBranchSelect}
      />
      <div className="border-t border-zinc-800 bg-zinc-900/30 px-3 py-2 text-[11px] text-zinc-600">
        {branches.length} branches total
      </div>
    </motion.div>
  );
}

function BranchSelectorList({
  branches,
  currentBranch,
  isLoading,
  onSelect,
}: {
  branches: BranchSelectorBranch[];
  currentBranch: string;
  isLoading: boolean;
  onSelect: (branch: string) => void;
}) {
  if (isLoading)
    return (
      <div className="px-4 py-6 text-center text-sm text-zinc-500">
        Loading branches...
      </div>
    );
  if (branches.length === 0)
    return (
      <div className="px-4 py-6 text-center text-sm text-zinc-500">
        No branches found
      </div>
    );
  return (
    <div className="max-h-56 overflow-y-auto py-1 no-scrollbar">
      {branches.map((branch) => (
        <button
          type="button"
          key={branch.name}
          onClick={() => onSelect(branch.name)}
          className={cn(
            "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-800/70",
            branch.name === currentBranch && "bg-zinc-800/60 text-white",
          )}
        >
          <span className="w-4">
            {branch.name === currentBranch ? (
              <Check size={14} className="text-emerald-400" />
            ) : (
              <GitBranch size={14} className="text-zinc-600" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{branch.name}</span>
        </button>
      ))}
    </div>
  );
}

function sortBranches(
  branches: BranchSelectorBranch[],
  currentBranch: string,
): BranchSelectorBranch[] {
  return [...branches].sort((left, right) => {
    if (left.name === currentBranch) return -1;
    if (right.name === currentBranch) return 1;
    if (left.protected !== right.protected) return left.protected ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
