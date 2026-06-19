import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, Loader2, Search } from "lucide-react";
import type { Branch } from "../../services/GitHubService";
import { listBranches } from "../../services/GitHubService";
import { useOutsideDismiss } from "../../hooks/useOutsideDismiss";
import { useGitHub } from "../github/GitHubContextProvider";

export function WelcomeBranchSelector() {
  const { repo, branch, switchBranch } = useGitHub();
  const [isOpen, setIsOpen] = useState(false);
  const { branches, loading } = useWelcomeBranches(repo);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setIsOpen(false), []);
  useOutsideDismiss(rootRef, isOpen, close);

  if (!repo) return null;
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-200"
        aria-label="Select branch"
      >
        <GitBranch size={12} />
        <span className="max-w-40 truncate">
          {branch || repo.default_branch}
        </span>
        <ChevronDown size={12} />
      </button>
      {isOpen ? (
        <WelcomeBranchPopover
          branches={branches}
          currentBranch={branch}
          loading={loading}
          onSelect={(next) => {
            switchBranch(next);
            close();
          }}
        />
      ) : null}
    </div>
  );
}

function WelcomeBranchPopover({
  branches,
  currentBranch,
  loading,
  onSelect,
}: {
  branches: Branch[];
  currentBranch: string;
  loading: boolean;
  onSelect: (branch: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = branches.filter((item) =>
    item.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-2xl border border-zinc-700 bg-[#171719] shadow-2xl">
      <label className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2.5">
        <Search size={14} className="text-zinc-500" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search branches"
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none"
        />
      </label>
      <div className="max-h-64 overflow-y-auto py-1 no-scrollbar">
        <WelcomeBranchList
          items={filtered}
          currentBranch={currentBranch}
          loading={loading}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}

function WelcomeBranchList({
  items,
  currentBranch,
  loading,
  onSelect,
}: {
  items: Branch[];
  currentBranch: string;
  loading: boolean;
  onSelect: (branch: string) => void;
}) {
  if (loading)
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-sm text-zinc-500">
        <Loader2 size={14} className="animate-spin" />
        Loading branches...
      </div>
    );
  return (
    <>
      {items.map((item) => (
        <button
          type="button"
          key={item.name}
          onClick={() => onSelect(item.name)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800"
        >
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          {item.name === currentBranch ? <Check size={14} /> : null}
        </button>
      ))}
    </>
  );
}

function useWelcomeBranches(repo: ReturnType<typeof useGitHub>["repo"]): {
  branches: Branch[];
  loading: boolean;
} {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    setLoading(true);
    void listBranches(repo.owner.login, repo.name)
      .then((items) => {
        if (!cancelled) setBranches(items);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);
  return { branches, loading };
}
