import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  GitBranch,
  Github,
  LoaderCircle,
  Lock,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { Branch, Repository } from "../../services/GitHubService";
import * as GitHubService from "../../services/GitHubService";
import { sortBranchesForRepoPicker } from "./sortBranchesForRepoPicker";

interface AuthorizedRepositoryPickerProps {
  onRepoSelect: (repo: Repository, branch: string) => void | Promise<void>;
  onClose?: () => void;
}

type LoadState = "loading" | "ready" | "error";

export function AuthorizedRepositoryPicker({
  onRepoSelect,
  onClose,
}: AuthorizedRepositoryPickerProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [query, setQuery] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [repoState, setRepoState] = useState<LoadState>("loading");
  const [branchState, setBranchState] = useState<LoadState>("ready");
  const [isOpening, setIsOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const loadRepositories = async () => {
    setRepoState("loading");
    try {
      const nextRepos = await GitHubService.listRepositories("all", "updated");
      setRepos(nextRepos);
      setRepoState("ready");
      requestAnimationFrame(() => searchRef.current?.focus());
    } catch {
      setRepoState("error");
    }
  };

  useEffect(() => {
    let cancelled = false;
    void GitHubService.listRepositories("all", "updated")
      .then((nextRepos) => {
        if (cancelled) return;
        setRepos(nextRepos);
        setRepoState("ready");
        requestAnimationFrame(() => searchRef.current?.focus());
      })
      .catch(() => {
        if (!cancelled) setRepoState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredRepos = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return repos;
    return repos.filter((repo) =>
      `${repo.full_name} ${repo.description ?? ""} ${repo.language ?? ""}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [query, repos]);

  const selectRepository = async (repo: Repository) => {
    setSelectedRepo(repo);
    setSelectedBranch(repo.default_branch);
    setBranches([]);
    setBranchState("loading");
    setOpenError(null);
    try {
      const branchList = await GitHubService.listBranches(
        repo.owner.login,
        repo.name,
      );
      setBranches(sortBranchesForRepoPicker(branchList, repo.default_branch));
      setBranchState("ready");
    } catch {
      setBranchState("error");
    }
  };

  const openWorkspace = async () => {
    if (!selectedRepo || !selectedBranch || isOpening) return;
    setIsOpening(true);
    setOpenError(null);
    try {
      await onRepoSelect(selectedRepo, selectedBranch);
    } catch {
      setOpenError("LegionCode could not open this workspace. Retry the selection.");
      setIsOpening(false);
    }
  };

  const formatActivityDate = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(value));

  return (
    <main className="flex h-full min-h-0 w-full flex-col bg-[#090a0c] text-[#f2f4f7]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#282c34] px-5 sm:px-8">
        <div className="flex items-center gap-2.5 text-sm font-semibold">
          <span className="grid h-7 w-7 place-items-center border border-[#3a404a] bg-[#111318] font-mono text-[10px]">LC</span>
          LegionCode
        </div>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label="Close repository picker" className="rounded-md p-2 text-[#969daa] hover:bg-[#171a20] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#65b8ff]">
            <X size={17} />
          </button>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#969daa]">Repository access</span>
        )}
      </header>

      <section aria-labelledby="repository-picker-title" className="mx-auto flex min-h-0 w-full max-w-[780px] flex-1 flex-col px-5 py-8 sm:px-8 sm:py-12">
        <div className="shrink-0">
          <div className="mb-4 flex items-center gap-2 font-mono text-[11px] text-[#969daa]">
            <span className="text-[#47d18c]">01 AUTHORIZED</span>
            <ArrowRight size={12} />
            <span className={selectedRepo ? "text-[#47d18c]" : "text-[#65b8ff]"}>02 REPOSITORY</span>
            <ArrowRight size={12} />
            <span className={selectedRepo ? "text-[#65b8ff]" : "text-[#5f6672]"}>03 BRANCH</span>
            <ArrowRight size={12} />
            <span className="text-[#5f6672]">04 WORKSPACE</span>
          </div>
          <h1 id="repository-picker-title" className="text-2xl font-medium tracking-tight sm:text-[28px] sm:leading-[34px]">
            Choose where LegionCode should work
          </h1>
          <p className="mt-2 text-sm text-[#969daa]">Only repositories granted through GitHub are shown.</p>
        </div>

        <div className="relative mt-7 shrink-0">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#69717e]" size={16} />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search repositories" placeholder="Search repositories…" className="h-11 w-full rounded-lg border border-[#343943] bg-[#111318] pl-10 pr-4 text-sm text-white placeholder:text-[#69717e] focus:border-[#65b8ff] focus:outline-none focus:ring-1 focus:ring-[#65b8ff]" />
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-hidden border-y border-[#282c34]">
          {repoState === "loading" ? (
            <StatusRow icon={<LoaderCircle className="animate-spin" size={17} />} label="Loading authorized repositories…" />
          ) : repoState === "error" ? (
            <StatusRow icon={<AlertCircle size={17} />} label="Repository access could not be loaded." action="Retry" onAction={() => void loadRepositories()} />
          ) : filteredRepos.length === 0 ? (
            <div className="flex h-full min-h-56 flex-col items-center justify-center px-4 text-center">
              <Github size={22} className="text-[#69717e]" />
              <h2 className="mt-4 text-sm font-semibold">No repositories are available</h2>
              <p className="mt-1 text-xs text-[#969daa]">Grant access on GitHub, then refresh this list.</p>
              <button type="button" onClick={GitHubService.initiateGitHubReauthorization} className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-md border border-[#343943] px-3 text-xs font-medium hover:bg-[#171a20]">
                Manage GitHub access <ExternalLink size={13} />
              </button>
            </div>
          ) : (
            <div className="h-full max-h-[384px] overflow-y-auto">
              {filteredRepos.map((repo) => {
                const selected = selectedRepo?.id === repo.id;
                return (
                  <button key={repo.id} type="button" onClick={() => void selectRepository(repo)} aria-pressed={selected} className={`grid min-h-[64px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[#20242b] px-3 text-left transition last:border-b-0 hover:bg-[#171a20] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#65b8ff] sm:px-4 ${selected ? "bg-[#171a20]" : "bg-[#111318]"}`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{repo.full_name}</span>
                        {repo.private ? <Lock size={12} className="shrink-0 text-[#969daa]" aria-label="Private" /> : null}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-[#969daa]">
                        <span>{repo.language ?? "Repository"}</span><span>{repo.default_branch}</span><span>{formatActivityDate(repo.updated_at)}</span>
                      </div>
                    </div>
                    <span className={`grid h-5 w-5 place-items-center rounded-full border ${selected ? "border-[#65b8ff] bg-[#65b8ff] text-[#090a0c]" : "border-[#4a515d] text-transparent"}`}><Check size={12} /></span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 pt-5">
          {selectedRepo ? (
            <div className="mb-4 flex flex-col gap-3 border-l border-[#65b8ff] pl-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0 flex-1">
                <label htmlFor="repository-branch" className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#969daa]">Starting branch</label>
                {branchState === "loading" ? <div className="flex h-10 items-center gap-2 text-xs text-[#969daa]"><LoaderCircle className="animate-spin" size={14} /> Loading branches…</div> : branchState === "error" ? <button type="button" onClick={() => void selectRepository(selectedRepo)} className="flex h-10 items-center gap-2 text-xs text-[#e3a95c]"><RefreshCw size={13} /> Retry branch access</button> : <div className="relative"><GitBranch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#969daa]" size={14} /><select id="repository-branch" value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)} className="h-10 w-full appearance-none rounded-md border border-[#343943] bg-[#111318] pl-9 pr-8 font-mono text-xs text-white focus:border-[#65b8ff] focus:outline-none sm:max-w-sm">{branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}{branch.name === selectedRepo.default_branch ? " · default" : ""}</option>)}</select></div>}
              </div>
              <button type="button" onClick={() => void openWorkspace()} disabled={!selectedBranch || branchState !== "ready" || isOpening} className="flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#f2f4f7] px-5 text-sm font-semibold text-[#090a0c] hover:bg-white disabled:cursor-not-allowed disabled:opacity-40">
                {isOpening ? <LoaderCircle className="animate-spin" size={15} /> : null} Open {selectedRepo.full_name}
              </button>
            </div>
          ) : null}
          {openError ? <p role="alert" className="mb-3 text-xs text-[#f06a6a]">{openError}</p> : null}
          <div className="flex items-center justify-between text-xs">
            {repoState === "ready" && repos.length > 0 ? (
              <button type="button" onClick={GitHubService.initiateGitHubReauthorization} className="inline-flex items-center gap-1.5 text-[#969daa] hover:text-white"><Github size={13} /> Manage GitHub access</button>
            ) : <span />}
            {onClose ? <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 text-[#969daa] hover:text-white"><ArrowLeft size={13} /> Back to workspace</button> : null}
          </div>
        </div>
      </section>
    </main>
  );
}

function StatusRow({ icon, label, action, onAction }: { icon: React.ReactNode; label: string; action?: string; onAction?: () => void }) {
  return <div className="flex h-full min-h-56 items-center justify-center gap-3 text-sm text-[#969daa]">{icon}<span>{label}</span>{action ? <button type="button" onClick={onAction} className="text-[#65b8ff] hover:text-white">{action}</button> : null}</div>;
}
