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
  List as ListIcon,
  Loader2,
  Plus,
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
import { BranchSelectorPanel } from "../../github/BranchSelector";

export interface EnvironmentSummaryMenuProps {
  repo: Repository | null;
  branch: string;
  changedFileCount: number;
  onBranchChange: (branch: string) => void;
  onOpenChanges: () => void;
  onOpenCommit: () => void;
}

export function EnvironmentSummaryMenu(props: EnvironmentSummaryMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isBranchOpen, setIsBranchOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setIsOpen(false);
    setIsBranchOpen(false);
  }, []);
  const { branches, loading } = useBranches(props.repo);
  useOutsideDismiss(rootRef, isOpen || isBranchOpen, close);

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
        <ListIcon size={18} />
      </button>
      {isOpen ? (
        <EnvironmentPanel
          {...props}
          onClose={close}
          onOpenBranch={() => setIsBranchOpen((current) => !current)}
        />
      ) : null}
      {isBranchOpen && props.repo ? (
        <BranchSelectorPanel
          branches={branches}
          currentBranch={props.branch}
          isLoading={loading}
          className="left-3 top-[88px]"
          onBranchSelect={(branch) => {
            props.onBranchChange(branch);
            setIsBranchOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function EnvironmentPanel(
  props: EnvironmentSummaryMenuProps & {
    onClose: () => void;
    onOpenBranch: () => void;
  },
) {
  const [runtimeOpen, setRuntimeOpen] = useState(false);
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
    pullRequest,
    pullRequestLoading,
    runtimeOpen,
    setRuntimeOpen,
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
      className="absolute right-0 top-11 z-50 w-[420px] rounded-2xl border border-zinc-700/80 bg-[#171719] p-2 shadow-2xl"
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
  pullRequest: PullRequestSummary | null;
  pullRequestLoading: boolean;
  runtimeOpen: boolean;
  setRuntimeOpen: (open: boolean) => void;
  onOpenBranch: () => void;
}

function EnvironmentActions(props: EnvironmentActionsProps) {
  const {
    repo,
    branch,
    changedFileCount,
    pullRequest,
    pullRequestLoading,
    runtimeOpen,
    setRuntimeOpen,
    onOpenBranch,
    onOpenChanges,
    onOpenCommit,
  } = props;
  return (
    <>
      <ChangesAction count={changedFileCount} onClick={onOpenChanges} />
      <RuntimeAction
        open={runtimeOpen}
        onToggle={() => setRuntimeOpen(!runtimeOpen)}
      />
      <BranchAction repo={repo} branch={branch} onToggle={onOpenBranch} />
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
  onToggle,
}: {
  repo: Repository | null;
  branch: string;
  onToggle: () => void;
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
      className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-zinc-100 transition-colors hover:bg-zinc-800"
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
