import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
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
  const dialogRef = useRef<HTMLElement>(null);
  const branchRequestRef = useRef(0);

  useEffect(() => {
    const previousFocus = document.activeElement;
    return () => {
      branchRequestRef.current += 1;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
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
    const request = ++branchRequestRef.current;
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
      if (request !== branchRequestRef.current) return;
      const sortedBranches = sortBranchesForRepoPicker(
        branchList,
        repo.default_branch,
      );
      setBranches(sortedBranches);
      setSelectedBranch(
        sortedBranches.some((branch) => branch.name === repo.default_branch)
          ? repo.default_branch
          : (sortedBranches[0]?.name ?? ""),
      );
      setBranchState("ready");
    } catch {
      if (request === branchRequestRef.current) setBranchState("error");
    }
  };

  const openWorkspace = async () => {
    if (
      !selectedRepo ||
      !selectedBranch ||
      branchState !== "ready" ||
      !branches.some((branch) => branch.name === selectedBranch) ||
      isOpening
    )
      return;
    setIsOpening(true);
    setOpenError(null);
    try {
      await onRepoSelect(selectedRepo, selectedBranch);
    } catch {
      setOpenError("Could not add this project. Try again.");
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
    <main
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="repository-picker-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isOpening) onClose?.();
        if (event.key !== "Tab") return;
        const controls = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), select:not([disabled])",
          ) ?? [],
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      className="relative flex max-h-[calc(100dvh-3rem)] min-h-0 w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-[#111113] text-zinc-100 shadow-2xl"
    >
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          disabled={isOpening}
          aria-label="Close repository picker"
          className="absolute right-4 top-4 z-10 rounded-md p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:opacity-40"
        >
          <X size={17} />
        </button>
      ) : null}
      <section className="flex min-h-0 flex-col px-5 py-6 sm:px-7">
        <div className="shrink-0 pr-10">
          <h1
            id="repository-picker-title"
            className="text-2xl font-medium tracking-tight sm:text-[28px] sm:leading-[34px]"
          >
            Add a project
          </h1>
          <p className="mt-2 text-sm text-[#969daa]">
            Choose a GitHub repository. It will be added after you confirm.
          </p>
        </div>

        <div className="relative mt-7 shrink-0">
          <Search
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#69717e]"
            size={16}
          />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search repositories"
            placeholder="Search repositories…"
            className="h-11 w-full rounded-lg border border-[#343943] bg-[#111318] pl-10 pr-4 text-sm text-white placeholder:text-[#69717e] focus:border-[#65b8ff] focus:outline-none focus:ring-1 focus:ring-[#65b8ff]"
          />
        </div>

        <div className="mt-4 min-h-24 shrink overflow-y-auto rounded-lg border border-[#282c34]">
          {repoState === "loading" ? (
            <StatusRow
              icon={<LoaderCircle className="animate-spin" size={17} />}
              label="Loading authorized repositories…"
            />
          ) : repoState === "error" ? (
            <StatusRow
              icon={<AlertCircle size={17} />}
              label="Repository access could not be loaded."
              action="Retry"
              onAction={() => void loadRepositories()}
            />
          ) : filteredRepos.length === 0 ? (
            <div className="flex h-full min-h-56 flex-col items-center justify-center px-4 text-center">
              <Github size={22} className="text-[#69717e]" />
              <h2 className="mt-4 text-sm font-semibold">
                {repos.length > 0
                  ? "No matching repositories"
                  : "No repositories are available"}
              </h2>
              <p className="mt-1 text-xs text-[#969daa]">
                {repos.length > 0
                  ? "Try another repository name."
                  : "Grant access on GitHub, then refresh this list."}
              </p>
              {repos.length === 0 ? (
                <button
                  type="button"
                  onClick={GitHubService.initiateGitHubReauthorization}
                  className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-md border border-[#343943] px-3 text-xs font-medium hover:bg-[#171a20]"
                >
                  Manage GitHub access <ExternalLink size={13} />
                </button>
              ) : null}
            </div>
          ) : (
            <div className="max-h-[min(40dvh,320px)] overflow-y-auto">
              {filteredRepos.map((repo) => {
                const selected = selectedRepo?.id === repo.id;
                return (
                  <button
                    key={repo.id}
                    type="button"
                    disabled={isOpening}
                    onClick={() => void selectRepository(repo)}
                    aria-pressed={selected}
                    className={`grid min-h-[64px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[#20242b] px-3 text-left transition last:border-b-0 hover:bg-[#171a20] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#65b8ff] sm:px-4 ${selected ? "bg-[#171a20]" : "bg-[#111318]"}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {repo.full_name}
                        </span>
                        {repo.private ? (
                          <Lock
                            size={12}
                            className="shrink-0 text-[#969daa]"
                            aria-label="Private"
                          />
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-[#969daa]">
                        <span>{repo.language ?? "Repository"}</span>
                        <span>{repo.default_branch}</span>
                        <span>{formatActivityDate(repo.updated_at)}</span>
                      </div>
                    </div>
                    <span
                      className={`grid h-5 w-5 place-items-center rounded-full border ${selected ? "border-[#65b8ff] bg-[#65b8ff] text-[#090a0c]" : "border-[#4a515d] text-transparent"}`}
                    >
                      <Check size={12} />
                    </span>
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
                <label
                  htmlFor="repository-branch"
                  className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#969daa]"
                >
                  Starting branch
                </label>
                {branchState === "loading" ? (
                  <div className="flex h-10 items-center gap-2 text-xs text-[#969daa]">
                    <LoaderCircle className="animate-spin" size={14} /> Loading
                    branches…
                  </div>
                ) : branchState === "error" ? (
                  <button
                    type="button"
                    onClick={() => void selectRepository(selectedRepo)}
                    className="flex h-10 items-center gap-2 text-xs text-[#e3a95c]"
                  >
                    <RefreshCw size={13} /> Retry branch access
                  </button>
                ) : (
                  <div className="relative">
                    <GitBranch
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#969daa]"
                      size={14}
                    />
                    <select
                      id="repository-branch"
                      value={selectedBranch}
                      onChange={(event) =>
                        setSelectedBranch(event.target.value)
                      }
                      className="h-10 w-full appearance-none rounded-md border border-[#343943] bg-[#111318] pl-9 pr-8 font-mono text-xs text-white focus:border-[#65b8ff] focus:outline-none sm:max-w-sm"
                    >
                      {branches.map((branch) => (
                        <option key={branch.name} value={branch.name}>
                          {branch.name}
                          {branch.name === selectedRepo.default_branch
                            ? " · default"
                            : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void openWorkspace()}
                disabled={
                  !selectedBranch || branchState !== "ready" || isOpening
                }
                className="flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#f2f4f7] px-5 text-sm font-semibold text-[#090a0c] hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isOpening ? (
                  <LoaderCircle className="animate-spin" size={15} />
                ) : null}{" "}
                {isOpening ? "Adding project…" : "Add project"}
              </button>
            </div>
          ) : null}
          {openError ? (
            <p role="alert" className="mb-3 text-xs text-[#f06a6a]">
              {openError}
            </p>
          ) : null}
          <div className="flex items-center justify-between text-xs">
            {repoState === "ready" && repos.length > 0 ? (
              <button
                type="button"
                onClick={GitHubService.initiateGitHubReauthorization}
                className="inline-flex items-center gap-1.5 text-[#969daa] hover:text-white"
              >
                <Github size={13} /> Manage GitHub access
              </button>
            ) : (
              <span />
            )}
            {onClose ? (
              <button
                type="button"
                disabled={isOpening}
                onClick={onClose}
                className="rounded-md px-3 py-2 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

function StatusRow({
  icon,
  label,
  action,
  onAction,
}: {
  icon: React.ReactNode;
  label: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex h-full min-h-56 items-center justify-center gap-3 text-sm text-[#969daa]">
      {icon}
      <span>{label}</span>
      {action ? (
        <button
          type="button"
          onClick={onAction}
          className="text-[#65b8ff] hover:text-white"
        >
          {action}
        </button>
      ) : null}
    </div>
  );
}
