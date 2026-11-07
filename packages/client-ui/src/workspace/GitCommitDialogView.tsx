import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Check, GitBranch, X, type LucideIcon } from "lucide-react";
import type { GitCommitIdentity } from "@repo/shared-types";

export type CommitNextStep = "commit" | "commit-and-push" | "commit-and-pr";
export interface GitFlowSuccessState {
  kind: CommitNextStep;
  branch: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
}
export interface GitCommitStepOption {
  id: CommitNextStep;
  label: string;
  detail: string;
  enabled: boolean;
  icon: LucideIcon;
}
export interface GitCommitDialogViewProps {
  onClose: () => void;
  branchLabel: string;
  totalChanges: number;
  additions: number | null;
  deletions: number | null;
  includeUnstaged: boolean;
  setIncludeUnstaged: Dispatch<SetStateAction<boolean>>;
  selectionControl?: ReactNode;
  resolvedCommitIdentity: GitCommitIdentity | null;
  authorFormVisible: boolean;
  requiresAuthorInput: boolean;
  setUseCustomAuthor: Dispatch<SetStateAction<boolean>>;
  authorName: string;
  authorEmail: string;
  setAuthorName: Dispatch<SetStateAction<string>>;
  setAuthorEmail: Dispatch<SetStateAction<string>>;
  commitMessage: string;
  setCommitMessage: (value: string) => void;
  messagePlaceholder?: string;
  stepOptions: readonly GitCommitStepOption[];
  nextStep: CommitNextStep;
  setNextStep: Dispatch<SetStateAction<CommitNextStep>>;
  requiresBranchInput: boolean;
  currentBranch: string;
  defaultBranch: string;
  branchName: string;
  setBranchName: Dispatch<SetStateAction<string>>;
  requiresPullRequestInput: boolean;
  repo: boolean;
  pullRequestTitle: string;
  setPullRequestTitle: Dispatch<SetStateAction<string>>;
  pullRequestBody: string;
  setPullRequestBody: Dispatch<SetStateAction<string>>;
  flowSuccess: GitFlowSuccessState | null;
  errorMessage: string | null;
  handleContinue: () => void | Promise<void>;
  canContinue: boolean;
  submittingFlow: boolean;
}

/** Exact Web commit surface. Hosts retain mutation, identity and repository authority. */
export function GitCommitDialogView({
  onClose, branchLabel, totalChanges, additions, deletions,
  includeUnstaged, setIncludeUnstaged, selectionControl,
  resolvedCommitIdentity, authorFormVisible, requiresAuthorInput,
  setUseCustomAuthor, authorName, authorEmail, setAuthorName, setAuthorEmail,
  commitMessage, setCommitMessage,
  messagePlaceholder = "Leave blank to autogenerate a commit message",
  stepOptions, nextStep, setNextStep, requiresBranchInput,
  currentBranch, defaultBranch, branchName, setBranchName,
  requiresPullRequestInput, repo, pullRequestTitle, setPullRequestTitle,
  pullRequestBody, setPullRequestBody, flowSuccess, errorMessage,
  handleContinue, canContinue, submittingFlow,
}: GitCommitDialogViewProps) {
  return (
    <div className="ui-overlay absolute inset-0 z-30 flex items-center justify-center px-4 py-4 sm:px-6 sm:py-6">
      <button
        type="button"
        className="absolute inset-0"
        aria-label="Close commit dialog"
        onClick={onClose}
      />

      <div className="ui-surface-modal relative flex max-h-full w-full max-w-xl flex-col overflow-hidden">
        <div className="flex items-start justify-between px-6 py-5">
          <div className="space-y-3">
            <h2 className="text-[1.8rem] font-semibold tracking-tight text-white">
              Commit your changes
            </h2>
            <div className="flex flex-wrap items-center gap-5 text-sm text-zinc-300">
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                  Branch
                </div>
                <div className="flex items-center gap-2 text-base text-white">
                  <GitBranch size={16} className="text-emerald-400" />
                  <span>{branchLabel}</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                  Changes
                </div>
                <div className="flex items-center gap-3 text-base">
                  <span className="text-white">{totalChanges} files</span>
                  <span className="text-emerald-400">{additions === null ? "Additions unavailable" : `+${additions}`}</span>
                  <span className="text-red-400">{deletions === null ? "Deletions unavailable" : `-${deletions}`}</span>
                </div>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-2.5 text-zinc-400 transition-colors hover:border-zinc-700 hover:text-white"
            title="Close commit dialog"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 space-y-5 overflow-y-auto border-t border-zinc-800 px-6 py-5">
          {selectionControl ?? (
          <div className="ui-surface-section flex items-center justify-between px-4 py-3.5">
            <div>
              <div className="text-base font-medium text-white">
                Include unstaged
              </div>
              <div className="text-xs text-zinc-500">
                Stage remaining changes before committing
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={includeUnstaged}
              onClick={() => setIncludeUnstaged((previous) => !previous)}
              className={`relative inline-flex h-8 w-14 items-center rounded-full border border-zinc-700 transition-colors ${
                includeUnstaged ? "bg-blue-500" : "bg-zinc-700"
              }`}
            >
              <span
                className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform ${
                  includeUnstaged ? "translate-x-7" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          )}

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-base font-medium text-white">
                  Commit author
                </div>
                <div className="text-xs text-zinc-500">
                  {resolvedCommitIdentity && !authorFormVisible
                    ? `Using ${formatCommitIdentitySource(resolvedCommitIdentity.source)}`
                    : "LegionCode needs a name and email for this commit"}
                </div>
              </div>
              {!requiresAuthorInput && resolvedCommitIdentity ? (
                <button
                  type="button"
                  onClick={() => {
                    setUseCustomAuthor((current) => !current);
                    setAuthorName(resolvedCommitIdentity.authorName);
                    setAuthorEmail(resolvedCommitIdentity.authorEmail);
                  }}
                  className="text-xs font-medium text-zinc-400 transition-colors hover:text-white"
                >
                  {authorFormVisible
                    ? "Use resolved author"
                    : "Use different author"}
                </button>
              ) : null}
            </div>

            {resolvedCommitIdentity && !authorFormVisible ? (
              <div className="ui-surface-section px-4 py-3 text-sm text-zinc-200">
                <div className="font-medium text-white">
                  {resolvedCommitIdentity.authorName}
                </div>
                <div className="text-zinc-400">
                  {resolvedCommitIdentity.authorEmail}
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                    Author name
                  </span>
                  <input
                    value={authorName}
                    onChange={(event) => setAuthorName(event.target.value)}
                    placeholder="Your name"
                    className="ui-input w-full px-4 py-3 text-sm"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                    Author email
                  </span>
                  <input
                    value={authorEmail}
                    onChange={(event) => setAuthorEmail(event.target.value)}
                    placeholder="name@example.com"
                    className="ui-input w-full px-4 py-3 text-sm"
                  />
                </label>
              </div>
            )}
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="git-commit-message"
                className="text-base font-medium text-white"
              >
                Commit message
              </label>
              <span className="text-xs text-zinc-500">Custom instructions</span>
            </div>
            <textarea
              id="git-commit-message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder={messagePlaceholder}
              className="ui-input min-h-28 w-full px-4 py-3 text-sm"
            />
          </div>

          <div className="ui-surface-section space-y-3 p-3.5">
            <div className="text-base font-medium text-white">Next steps</div>
            <div className="overflow-hidden rounded-xl border border-zinc-800">
              {stepOptions.map((option, index) => {
                const Icon = option.icon;
                const isActive = nextStep === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => option.enabled && setNextStep(option.id)}
                    disabled={!option.enabled}
                    className={`flex w-full items-center justify-between px-3.5 py-3.5 text-left transition-colors ${
                      index > 0 ? "border-t border-zinc-800" : ""
                    } ${
                      option.enabled
                        ? "bg-transparent hover:bg-zinc-900/60"
                        : "cursor-not-allowed bg-black/30 text-zinc-600"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Icon
                        size={18}
                        className={
                          option.enabled ? "text-zinc-300" : "text-zinc-700"
                        }
                      />
                      <div>
                        <div
                          className={
                            option.enabled ? "text-sm text-white" : "text-sm"
                          }
                        >
                          {option.label}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {option.detail}
                        </div>
                      </div>
                    </div>
                    {isActive && option.enabled ? (
                      <Check size={18} className="text-white" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          {requiresBranchInput ? (
            <div className="ui-surface-section space-y-3 p-3.5">
              <div>
                <div className="text-base font-medium text-white">
                  Branch target
                </div>
                <div className="text-xs text-zinc-500">
                  {currentBranch === defaultBranch
                    ? `Current branch is ${defaultBranch}. LegionCode will create a branch before pushing.`
                    : `Current branch is ${currentBranch}. You can keep it or push a new branch.`}
                </div>
              </div>
              <label className="space-y-2">
                <span className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                  Branch name
                </span>
                <input
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  placeholder="feat/my-change"
                  className="ui-input w-full px-4 py-3 text-sm"
                />
              </label>
            </div>
          ) : null}

          {requiresPullRequestInput ? (
            <div className="ui-surface-section space-y-3 p-3.5">
              <div>
                <div className="text-base font-medium text-white">
                  Pull request
                </div>
                <div className="text-xs text-zinc-500">
                  {repo
                    ? `PR base branch: ${defaultBranch}`
                    : "A GitHub repository context is required before creating a PR."}
                </div>
              </div>
              <label className="space-y-2">
                <span className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                  PR title
                </span>
                <input
                  value={pullRequestTitle}
                  onChange={(event) => setPullRequestTitle(event.target.value)}
                  placeholder="Describe the change"
                  className="ui-input w-full px-4 py-3 text-sm"
                />
              </label>
              <label className="space-y-2">
                <span className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                  PR body
                </span>
                <textarea
                  value={pullRequestBody}
                  onChange={(event) => setPullRequestBody(event.target.value)}
                  className="ui-input min-h-28 w-full px-4 py-3 text-sm"
                />
              </label>
            </div>
          ) : null}

          {flowSuccess ? (
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-200">
              <div className="font-medium text-white">
                {flowSuccess.kind === "commit-and-pr"
                  ? "Branch pushed and pull request created."
                  : "Branch pushed successfully."}
              </div>
              <div className="mt-1 text-emerald-300">
                Branch:{" "}
                <span className="font-medium text-white">
                  {flowSuccess.branch}
                </span>
              </div>
              {flowSuccess.pullRequestUrl ? (
                <a
                  href={flowSuccess.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex text-sm font-medium text-emerald-200 underline underline-offset-4 transition-colors hover:text-white"
                >
                  Open PR #{flowSuccess.pullRequestNumber}
                </a>
              ) : null}
            </div>
          ) : null}

          {errorMessage ? (
            <div className="rounded-2xl border border-red-500/25 bg-red-500/5 px-4 py-3 text-sm text-red-300">
              {errorMessage}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-4">
            <button
              type="button"
              onClick={handleContinue}
              disabled={!canContinue}
              className="shrink-0 rounded-full bg-white px-7 py-2.5 text-base font-medium text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {getPrimaryActionLabel(nextStep, submittingFlow, flowSuccess)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatCommitIdentitySource(
  source: GitCommitIdentity["source"],
): string {
  switch (source) {
    case "workspace_git_config":
      return "workspace git config";
    case "github_profile":
      return "your GitHub profile";
    case "user_input":
      return "manual author input";
    default:
      return "resolved author identity";
  }
}


function getPrimaryActionLabel(
  nextStep: CommitNextStep,
  submittingFlow: boolean,
  flowSuccess: GitFlowSuccessState | null,
): string {
  if (submittingFlow) {
    return "Working...";
  }

  if (flowSuccess) {
    return "Close";
  }

  switch (nextStep) {
    case "commit":
      return "Commit";
    case "commit-and-push":
      return "Commit and push";
    case "commit-and-pr":
      return "Commit and create PR";
    default:
      return "Continue";
  }
}
