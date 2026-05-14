import { useState, useEffect } from "react";
import { GitBranch, Star, Github, Search, Check } from "lucide-react";
import type { Repository, Branch } from "../../services/GitHubService";
import * as GitHubService from "../../services/GitHubService";
import { sortBranchesForRepoPicker } from "./sortBranchesForRepoPicker";

interface RepoPickerProps {
  onRepoSelect: (repo: Repository, branch: string) => void | Promise<void>;
  onSkip: () => void;
}

export function RepoPicker({ onRepoSelect, onSkip }: RepoPickerProps) {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [filteredRepos, setFilteredRepos] = useState<Repository[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<"repos" | "branches">("repos");

  useEffect(() => {
    loadRepositories();
  }, []);

  useEffect(() => {
    if (searchQuery) {
      const filtered = repos.filter(
        (repo) =>
          repo.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (repo.description?.toLowerCase() || "").includes(
            searchQuery.toLowerCase(),
          ),
      );
      setFilteredRepos(filtered);
    } else {
      setFilteredRepos(repos);
    }
  }, [searchQuery, repos]);

  const loadRepositories = async () => {
    try {
      setLoading(true);
      const repositories = await GitHubService.listRepositories(
        "all",
        "updated",
      );
      setRepos(repositories);
      setFilteredRepos(repositories);
    } catch (error) {
      console.error("Failed to load repositories:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleRepoClick = async (repo: Repository) => {
    setSelectedRepo(repo);
    setStep("branches");

    try {
      const branchList = await GitHubService.listBranches(
        repo.owner.login,
        repo.name,
      );
      setBranches(sortBranchesForRepoPicker(branchList, repo.default_branch));
      setSelectedBranch(repo.default_branch);
    } catch (error) {
      console.error("Failed to load branches:", error);
    }
  };

  const handleConfirm = () => {
    if (selectedRepo && selectedBranch) {
      onRepoSelect(selectedRepo, selectedBranch);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  if (step === "branches" && selectedRepo) {
    return (
      <div className="w-full max-w-4xl mx-auto p-6">
        <div className="mb-6">
          <button
            onClick={() => setStep("repos")}
            className="text-zinc-500 hover:text-zinc-300 text-sm mb-4"
          >
            ← Back to repositories
          </button>
          <h2 className="text-2xl font-semibold text-white mb-2">
            Select Branch
          </h2>
          <p className="text-zinc-400">
            Choose a branch to work on for{" "}
            <span className="text-white">{selectedRepo.full_name}</span>
          </p>
        </div>

        <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-zinc-800">
            <h3 className="text-sm font-medium text-zinc-300">
              Available Branches
            </h3>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {branches.map((branch) => (
              <button
                key={branch.name}
                onClick={() => setSelectedBranch(branch.name)}
                className={`w-full flex items-center justify-between p-4 border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/50 transition-colors ${
                  selectedBranch === branch.name ? "bg-zinc-800/70" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  <GitBranch className="w-4 h-4 text-zinc-500" />
                  <span
                    className={`text-sm ${
                      selectedBranch === branch.name
                        ? "text-white"
                        : "text-zinc-300"
                    }`}
                  >
                    {branch.name}
                  </span>
                  {branch.name === selectedRepo.default_branch && (
                    <span className="text-xs px-2 py-0.5 bg-zinc-800 text-zinc-500 rounded-full">
                      default
                    </span>
                  )}
                  {branch.protected && (
                    <span className="text-xs px-2 py-0.5 bg-amber-500/10 text-amber-500 rounded-full">
                      protected
                    </span>
                  )}
                </div>
                {selectedBranch === branch.name && (
                  <Check className="w-4 h-4 text-green-500" />
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-between mt-6">
          <button
            onClick={() => setStep("repos")}
            className="px-4 py-2 text-zinc-400 hover:text-white transition-colors"
          >
            Back
          </button>
          <div className="flex gap-3">
            <button
              onClick={onSkip}
              className="px-4 py-2 text-zinc-400 hover:text-white transition-colors"
            >
              Skip
            </button>
            <button
              onClick={handleConfirm}
              disabled={!selectedBranch}
              className="px-6 py-2 bg-white text-black rounded-md hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Connect Repository
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto p-6">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-zinc-900 rounded-2xl mb-4">
          <Github className="w-8 h-8 text-white" />
        </div>
        <h2 className="text-2xl font-semibold text-white mb-2">
          Connect Your Repository
        </h2>
        <p className="text-zinc-400 max-w-lg mx-auto">
          Select a GitHub repository to start working with LegionCode. You can
          also skip this step and connect later.
        </p>
      </div>

      <div className="mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-zinc-500" />
          <input
            type="text"
            placeholder="Search your repositories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition-colors"
          />
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin w-8 h-8 border-2 border-zinc-600 border-t-white rounded-full mx-auto mb-4" />
          <p className="text-zinc-500">Loading repositories...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-96 overflow-y-auto">
          {filteredRepos.map((repo) => (
            <button
              key={repo.id}
              onClick={() => handleRepoClick(repo)}
              className="flex flex-col p-4 bg-zinc-900/50 border border-zinc-800 rounded-lg hover:border-zinc-600 hover:bg-zinc-900 transition-all text-left group"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">📁</span>
                  <span className="font-medium text-white group-hover:text-zinc-200">
                    {repo.name}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-zinc-500">
                  <Star className="w-4 h-4" />
                  <span className="text-sm">{repo.stargazers_count}</span>
                </div>
              </div>

              {repo.description && (
                <p className="text-sm text-zinc-400 line-clamp-2 mb-3">
                  {repo.description}
                </p>
              )}

              <div className="flex items-center gap-3 mt-auto text-xs text-zinc-500">
                {repo.language && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-zinc-600" />
                    {repo.language}
                  </span>
                )}
                <span>{repo.private ? "Private" : "Public"}</span>
                <span>Updated {formatDate(repo.updated_at)}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {!loading && filteredRepos.length === 0 && (
        <div className="text-center py-12">
          <p className="text-zinc-500">
            {searchQuery
              ? "No repositories found matching your search"
              : "No repositories found"}
          </p>
        </div>
      )}

      <div className="flex justify-end mt-6">
        <button
          onClick={onSkip}
          className="px-4 py-2 text-zinc-400 hover:text-white transition-colors"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
