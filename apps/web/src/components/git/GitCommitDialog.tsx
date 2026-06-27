import { useEffect, useMemo, useState } from "react";
import { Check, GitBranch, Github, Sparkles, Upload, X } from "lucide-react";
import { useGitReview } from "./useGitReview";
import { useAuth } from "../../contexts/AuthContext";
import { useGitHub } from "../github/GitHubContextProvider";
import { useRunContext } from "../../hooks/useRunContext";
import { SessionStateService } from "../../services/SessionStateService";
import { createGitPullRequest } from "../../lib/git-client";
import type { GitCommitIdentity } from "@repo/shared-types";

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_PR_BODY = ["## Summary", "-", "", "## Testing", "-"].join("\n");

interface GitCommitDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type CommitNextStep = "commit" | "commit-and-push" | "commit-and-pr";

interface GitFlowSuccessState {
  kind: CommitNextStep;
  branch: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
}

export function GitCommitDialog({ isOpen, onClose }: GitCommitDialogProps) {
  const {
    status,
    stagedFiles,
    stageAll,
    submitCommit,
    createBranch,
    pushBranch,
    commitMessage,
    setCommitMessage,
    stageError,
    commitError,
    commitErrorCode,
    commitErrorMetadata,
  } = useGitReview();
  const { user } = useAuth();
  const { repo, switchBranch } = useGitHub();
  const { runId, sessionId } = useRunContext();
  const [includeUnstaged, setIncludeUnstaged] = useState(false);
  const [nextStep, setNextStep] = useState<CommitNextStep>("commit");
  const [useCustomAuthor, setUseCustomAuthor] = useState(false);
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [branchName, setBranchName] = useState("");
  const [pullRequestTitle, setPullRequestTitle] = useState("");
  const [pullRequestBody, setPullRequestBody] = useState(DEFAULT_PR_BODY);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [flowSuccess, setFlowSuccess] = useState<GitFlowSuccessState | null>(
    null,
  );
  const [submittingFlow, setSubmittingFlow] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const totalChanges = status?.files.length ?? 0;
  const stagedCount = stagedFiles.size;
  const unstagedCount = Math.max(totalChanges - stagedCount, 0);
  const additions =
    status?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions =
    status?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  const errorMessage = flowError ?? stageError ?? commitError;
  const sessionCommitIdentity = user?.commitIdentity;
  const workspaceCommitIdentity = status?.commitIdentity ?? null;
  const backendIdentityPrompt = commitErrorMetadata?.commitIdentity;
  const resolvedCommitIdentity =
    workspaceCommitIdentity ??
    (sessionCommitIdentity?.state === "ready"
      ? sessionCommitIdentity.identity
      : null);
  const suggestedAuthorName =
    backendIdentityPrompt?.state === "requires_input"
      ? backendIdentityPrompt.suggestedAuthorName
      : sessionCommitIdentity?.state === "requires_input"
        ? sessionCommitIdentity.suggestedAuthorName
        : (resolvedCommitIdentity?.authorName ??
          user?.name ??
          user?.login ??
          "");
  const suggestedAuthorEmail =
    backendIdentityPrompt?.state === "requires_input"
      ? backendIdentityPrompt.suggestedAuthorEmail
      : sessionCommitIdentity?.state === "requires_input"
        ? sessionCommitIdentity.suggestedAuthorEmail
        : (resolvedCommitIdentity?.authorEmail ?? user?.email ?? "");
  const requiresAuthorInput =
    !workspaceCommitIdentity &&
    (sessionCommitIdentity?.state === "requires_input" ||
      commitErrorCode === "COMMIT_IDENTITY_REQUIRED" ||
      commitErrorCode === "COMMIT_IDENTITY_INCOMPLETE");
  const authorFormVisible = useCustomAuthor || requiresAuthorInput;
  const hasValidAuthorOverride =
    !authorFormVisible ||
    (authorName.trim().length > 0 &&
      SIMPLE_EMAIL_PATTERN.test(authorEmail.trim()));
  const defaultBranch = repo?.default_branch?.trim() || "main";
  const currentBranch = status?.branch?.trim() || defaultBranch;
  const normalizedBranchName = branchName.trim();
  const requiresBranchInput = nextStep !== "commit";
  const requiresPullRequestInput = nextStep === "commit-and-pr";
  const hasValidBranchInput =
    !requiresBranchInput || normalizedBranchName.length > 0;
  const hasValidPullRequestInput =
    !requiresPullRequestInput ||
    (repo !== null && pullRequestTitle.trim().length > 0);
  const canContinue =
    !submittingFlow &&
    (stagedCount > 0 ||
      (includeUnstaged && unstagedCount > 0) ||
      flowSuccess) &&
    hasValidAuthorOverride &&
    hasValidBranchInput &&
    hasValidPullRequestInput;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const fallbackMessage = resolveFlowMessage(
      commitMessage,
      status?.files.length ?? 0,
    );
    setUseCustomAuthor(requiresAuthorInput);
    setAuthorName(suggestedAuthorName);
    setAuthorEmail(suggestedAuthorEmail);
    setBranchName(
      buildSuggestedBranchName(currentBranch, defaultBranch, fallbackMessage),
    );
    setPullRequestTitle(fallbackMessage);
    setPullRequestBody(DEFAULT_PR_BODY);
    setFlowError(null);
    setFlowSuccess(null);
    setSubmittingFlow(false);
  }, [
    commitMessage,
    currentBranch,
    defaultBranch,
    isOpen,
    requiresAuthorInput,
    status?.files.length,
    suggestedAuthorEmail,
    suggestedAuthorName,
  ]);

  const stepOptions = useMemo(
    () => [
      {
        id: "commit" as const,
        label: "Commit",
        detail:
          includeUnstaged && unstagedCount > 0
            ? `Includes ${unstagedCount} unstaged`
            : "Staged changes only",
        enabled: true,
        icon: Sparkles,
      },
      {
        id: "commit-and-push" as const,
        label: "Commit and push",
        detail: repo
          ? "Create or use a branch, then push it"
          : "Select a GitHub repo first",
        enabled: Boolean(user && repo),
        icon: Upload,
      },
      {
        id: "commit-and-pr" as const,
        label: "Commit and create PR",
        detail: repo
          ? `Push branch and open PR to ${defaultBranch}`
          : "Select a GitHub repo first",
        enabled: Boolean(user && repo),
        icon: Github,
      },
    ],
    [defaultBranch, includeUnstaged, repo, unstagedCount, user],
  );

  if (!isOpen) {
    return null;
  }

  const handleContinue = async () => {
    if (flowSuccess) {
      onClose();
      return;
    }

    setFlowError(null);
    setFlowSuccess(null);
    setSubmittingFlow(true);

    try {
      if (includeUnstaged && unstagedCount > 0) {
        const staged = await stageAll();
        if (!staged) {
          return;
        }
      }

      const identityOverride = authorFormVisible
        ? {
            authorName: authorName.trim(),
            authorEmail: authorEmail.trim(),
          }
        : undefined;
      const files = includeUnstaged
        ? (status?.files.map((file) => file.path) ?? [])
        : Array.from(stagedFiles);
      const committed = await submitCommit({ ...identityOverride, files });
      if (!committed) {
        return;
      }

      if (nextStep === "commit") {
        onClose();
        return;
      }

      const requestedBranch = normalizedBranchName || currentBranch;
      let activeBranch = requestedBranch;
      if (requestedBranch !== currentBranch) {
        activeBranch = await createBranch(requestedBranch);
      }

      activeBranch = await pushBranch(activeBranch);
      persistSessionBranch(sessionId, repo, activeBranch, switchBranch);

      if (nextStep === "commit-and-push") {
        setFlowSuccess({
          kind: nextStep,
          branch: activeBranch,
        });
        return;
      }

      if (!repo) {
        throw new Error(
          "Select a GitHub repository before creating a pull request.",
        );
      }
      if (!runId) {
        throw new Error("No run context available for pull request creation.");
      }

      const pullRequestResult = await createGitPullRequest({
        runId,
        sessionId: sessionId ?? undefined,
        payload: {
          owner: repo.owner.login,
          repo: repo.name,
          title: pullRequestTitle.trim(),
          body: normalizeOptionalText(pullRequestBody),
          base: defaultBranch,
        },
      });
      const pullRequest = pullRequestResult.pullRequest;
      setFlowSuccess({
        kind: nextStep,
        branch: activeBranch,
        pullRequestUrl: pullRequest.url,
        pullRequestNumber: pullRequest.number,
      });
    } catch (error) {
      setFlowError(
        error instanceof Error
          ? error.message
          : "Git flow failed unexpectedly.",
      );
    } finally {
      setSubmittingFlow(false);
    }
  };

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
                  <span>{status?.branch || "No branch"}</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                  Changes
                </div>
                <div className="flex items-center gap-3 text-base">
                  <span className="text-white">{totalChanges} files</span>
                  <span className="text-emerald-400">+{additions}</span>
                  <span className="text-red-400">-{deletions}</span>
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
              placeholder="Leave blank to autogenerate a commit message"
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

function normalizeOptionalText(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveFlowMessage(
  commitMessage: string,
  changedFilesCount: number,
): string {
  const normalizedMessage = commitMessage.trim();
  if (normalizedMessage.length > 0) {
    return normalizedMessage;
  }

  if (changedFilesCount <= 0) {
    return "chore(review): update workspace";
  }

  if (changedFilesCount === 1) {
    return "chore(review): update changed file";
  }

  return `chore(review): update ${changedFilesCount} files`;
}

function buildSuggestedBranchName(
  currentBranch: string,
  defaultBranch: string,
  message: string,
): string {
  if (currentBranch && currentBranch !== defaultBranch) {
    return currentBranch;
  }

  const slug = slugifyBranchSegment(message || "legioncode-update");
  return `feat/${slug}`;
}

function slugifyBranchSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return normalized.length > 0 ? normalized : "legioncode-update";
}

function persistSessionBranch(
  sessionId: string | null,
  repo: {
    owner: { login: string };
    name: string;
    full_name: string;
  } | null,
  branch: string,
  switchBranch: (branchName: string) => void,
): void {
  switchBranch(branch);

  if (!sessionId || !repo) {
    return;
  }

  SessionStateService.saveSessionGitHubContext(sessionId, {
    repoOwner: repo.owner.login,
    repoName: repo.name,
    fullName: repo.full_name,
    branch,
  });
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
