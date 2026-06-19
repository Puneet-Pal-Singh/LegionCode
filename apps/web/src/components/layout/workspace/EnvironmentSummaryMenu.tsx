import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  Laptop,
  ListFilter,
  Loader2,
  Plus,
  Search,
} from "lucide-react";
import type {
  Branch,
  PullRequestSummary,
  Repository,
} from "../../../services/GitHubService";
import {
  listBranches,
  listOpenPullRequests,
} from "../../../services/GitHubService";
import { useOutsideDismiss } from "../../../hooks/useOutsideDismiss";
import { cn } from "../../../lib/utils";

interface EnvironmentSummaryMenuProps {
  repo: Repository | null;
  branch: string;
  changedFileCount: number;
  onBranchChange: (branch: string) => void;
  onOpenChanges: () => void;
  onOpenCommit: () => void;
}

export function EnvironmentSummaryMenu(props: EnvironmentSummaryMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setIsOpen(false), []);
  useOutsideDismiss(rootRef, isOpen, close);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-label="Toggle environment summary"
        aria-expanded={isOpen}
        className={cn(
          "rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white",
          isOpen && "bg-zinc-800 text-white",
        )}
      >
        <ListFilter size={18} />
      </button>
      {isOpen ? <EnvironmentPanel {...props} onClose={close} /> : null}
    </div>
  );
}

function EnvironmentPanel(
  props: EnvironmentSummaryMenuProps & { onClose: () => void },
) {
  const [section, setSection] = useState<"branch" | "runtime" | null>(null);
  const { branches, loading: branchesLoading } = useBranches(props.repo);
  const { pullRequest, loading: pullRequestLoading } = useActivePullRequest(
    props.repo,
    props.branch,
  );
  const closeAfter = (action: () => void) => () => {
    action();
    props.onClose();
  };
  const actions = {
    ...props,
    branches,
    branchesLoading,
    pullRequest,
    pullRequestLoading,
    section,
    setSection,
    onOpenChanges: closeAfter(props.onOpenChanges),
    onOpenCommit: closeAfter(props.onOpenCommit),
  };
  return <EnvironmentPanelView actions={actions} />;
}

function EnvironmentPanelView({
  actions,
}: {
  actions: EnvironmentActionsProps;
}) {
  return (
    <div
      role="dialog"
      aria-label="Environment summary"
      className="absolute right-0 top-11 z-50 w-[360px] rounded-3xl border border-zinc-700 bg-[#202021] p-3 shadow-2xl"
    >
      <div className="flex items-center justify-between px-3 py-2 text-sm text-zinc-400">
        <span>Environment</span>
        <Plus size={20} />
      </div>
      <EnvironmentActions {...actions} />
    </div>
  );
}

interface EnvironmentActionsProps extends EnvironmentSummaryMenuProps {
  branches: Branch[];
  branchesLoading: boolean;
  pullRequest: PullRequestSummary | null;
  pullRequestLoading: boolean;
  section: "branch" | "runtime" | null;
  setSection: (section: "branch" | "runtime" | null) => void;
}

function EnvironmentActions(props: EnvironmentActionsProps) {
  const {
    repo,
    branch,
    changedFileCount,
    branches,
    branchesLoading,
    pullRequest,
    pullRequestLoading,
    section,
    setSection,
    onBranchChange,
    onOpenChanges,
    onOpenCommit,
  } = props;
  return (
    <>
      <ChangesAction count={changedFileCount} onClick={onOpenChanges} />
      <RuntimeAction
        open={section === "runtime"}
        onToggle={() => setSection(section === "runtime" ? null : "runtime")}
      />
      <BranchAction
        repo={repo}
        branch={branch}
        branches={branches}
        loading={branchesLoading}
        open={section === "branch"}
        onToggle={() => setSection(section === "branch" ? null : "branch")}
        onSelect={(nextBranch) => {
          onBranchChange(nextBranch);
          setSection(null);
        }}
      />
      <CommitAction visible={changedFileCount > 0} onClick={onOpenCommit} />
      <PullRequestStatus
        loading={pullRequestLoading}
        pullRequest={pullRequest}
      />
    </>
  );
}

function ChangesAction({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  if (count === 0) return null;
  return (
    <SummaryButton
      icon={<FileDiff size={17} />}
      label="Changes"
      detail={`${count}`}
      onClick={onClick}
    />
  );
}

function RuntimeAction({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <SummaryButton
        icon={<Cloud size={17} />}
        label="LegionCode cloud"
        chevron
        onClick={onToggle}
      />
      {open ? <RuntimeOptions /> : null}
    </>
  );
}

function BranchAction({
  repo,
  branch,
  branches,
  loading,
  open,
  onToggle,
  onSelect,
}: {
  repo: Repository | null;
  branch: string;
  branches: Branch[];
  loading: boolean;
  open: boolean;
  onToggle: () => void;
  onSelect: (branch: string) => void;
}) {
  if (!repo) return null;
  return (
    <>
      <SummaryButton
        icon={<GitBranch size={18} />}
        label={branch || repo.default_branch}
        chevron
        onClick={onToggle}
      />
      {open ? (
        <BranchOptions
          branches={branches}
          currentBranch={branch}
          loading={loading}
          onSelect={onSelect}
        />
      ) : null}
    </>
  );
}

function CommitAction({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  return visible ? (
    <SummaryButton
      icon={<GitCommitHorizontal size={18} />}
      label="Commit or push"
      onClick={onClick}
    />
  ) : null;
}

function PullRequestStatus({
  loading,
  pullRequest,
}: {
  loading: boolean;
  pullRequest: PullRequestSummary | null;
}) {
  if (loading)
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-sm text-zinc-500">
        <Loader2 size={15} className="animate-spin" />
        Checking pull request...
      </div>
    );
  return pullRequest ? <PullRequestLink pullRequest={pullRequest} /> : null;
}

function SummaryButton({
  icon,
  label,
  detail,
  chevron,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  chevron?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-zinc-100 hover:bg-zinc-700/60"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="text-xs text-zinc-500">{detail}</span> : null}
      {chevron ? <ChevronDown size={15} className="text-zinc-500" /> : null}
    </button>
  );
}

function RuntimeOptions() {
  return (
    <div className="mx-2 rounded-xl border border-zinc-700 bg-zinc-900/70 p-1">
      <div className="flex items-center gap-3 rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white">
        <Cloud size={16} />
        <span className="flex-1">LegionCode cloud</span>
        <Check size={15} />
      </div>
      <div
        aria-disabled="true"
        className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-600"
      >
        <Laptop size={16} />
        Work locally
      </div>
    </div>
  );
}

function BranchOptions({
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
    <div className="mx-2 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900/80">
      <label className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <Search size={14} className="text-zinc-500" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search branches"
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none"
        />
      </label>
      <div className="max-h-56 overflow-y-auto py-1 no-scrollbar">
        {loading ? (
          <div className="px-3 py-3 text-sm text-zinc-500">
            Loading branches...
          </div>
        ) : (
          filtered.map((item) => (
            <button
              type="button"
              key={item.name}
              onClick={() => onSelect(item.name)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800"
            >
              <span className="flex-1 truncate">{item.name}</span>
              {item.name === currentBranch ? <Check size={14} /> : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function PullRequestLink({ pullRequest }: { pullRequest: PullRequestSummary }) {
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      className="mt-2 flex items-center gap-3 rounded-xl border-t border-zinc-700 px-3 py-3 text-sm text-zinc-200 hover:bg-zinc-700/60"
    >
      <GitBranch size={17} />
      <span className="min-w-0 flex-1 truncate">{pullRequest.title}</span>
      <ExternalLink size={15} className="text-zinc-500" />
    </a>
  );
}

function useBranches(repo: Repository | null): {
  branches: Branch[];
  loading: boolean;
} {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!repo) {
      setBranches([]);
      return;
    }
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

function useActivePullRequest(
  repo: Repository | null,
  branch: string,
): { pullRequest: PullRequestSummary | null; loading: boolean } {
  const [pullRequest, setPullRequest] = useState<PullRequestSummary | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!repo || !branch) {
      setPullRequest(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void listOpenPullRequests(repo.owner.login, repo.name, branch)
      .then((items) => {
        if (!cancelled) setPullRequest(items[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setPullRequest(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branch, repo]);
  return { pullRequest, loading };
}
