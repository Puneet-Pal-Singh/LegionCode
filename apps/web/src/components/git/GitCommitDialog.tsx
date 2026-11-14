import { useEffect, useMemo, useState, useRef } from "react";
import { Github, Sparkles, Upload } from "lucide-react";
import { GitCommitDialogView, type CommitNextStep, type GitFlowSuccessState } from "@legioncode/client-ui";
import { useGitReview } from "./useGitReview";
import { useAuth } from "../../contexts/AuthContext";
import { useGitHub } from "../github/GitHubContextProvider";
import { useRunContext } from "../../hooks/useRunContext";
import { selectWorkspace } from "../../services/api/workspaceSelection";
import { saveSessionBranchPreference } from "../../lib/session-branch-preference";
import { createGitPullRequest } from "../../services/api/gitOperations";

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_PR_BODY = ["## Summary", "-", "", "## Testing", "-"].join("\n");

interface GitCommitDialogProps {
  isOpen: boolean;
  onClose: () => void;
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
  const sessionIdRef = useRef(sessionId);
  const runIdRef = useRef(runId);
  const repoFullNameRef = useRef(repo?.full_name ?? null);
  const isMountedRef = useRef(false);
  sessionIdRef.current = sessionId;
  runIdRef.current = runId;
  repoFullNameRef.current = repo?.full_name ?? null;
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
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

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
      await persistSessionBranch(
        sessionId,
        repo,
        activeBranch,
        switchBranch,
        () => isMountedRef.current && sessionIdRef.current === sessionId && runIdRef.current === runId && repoFullNameRef.current === repo?.full_name,
      );

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
    <GitCommitDialogView
      onClose={onClose}
      branchLabel={status?.branch || "No branch"}
      totalChanges={totalChanges}
      additions={additions}
      deletions={deletions}
      includeUnstaged={includeUnstaged}
      setIncludeUnstaged={setIncludeUnstaged}
      resolvedCommitIdentity={resolvedCommitIdentity}
      authorFormVisible={authorFormVisible}
      requiresAuthorInput={requiresAuthorInput}
      setUseCustomAuthor={setUseCustomAuthor}
      authorName={authorName} authorEmail={authorEmail}
      setAuthorName={setAuthorName} setAuthorEmail={setAuthorEmail}
      commitMessage={commitMessage} setCommitMessage={setCommitMessage}
      stepOptions={stepOptions} nextStep={nextStep} setNextStep={setNextStep}
      requiresBranchInput={requiresBranchInput}
      currentBranch={currentBranch} defaultBranch={defaultBranch}
      branchName={branchName} setBranchName={setBranchName}
      requiresPullRequestInput={requiresPullRequestInput} repo={Boolean(repo)}
      pullRequestTitle={pullRequestTitle} setPullRequestTitle={setPullRequestTitle}
      pullRequestBody={pullRequestBody} setPullRequestBody={setPullRequestBody}
      flowSuccess={flowSuccess} errorMessage={errorMessage}
      handleContinue={handleContinue} canContinue={Boolean(canContinue)}
      submittingFlow={submittingFlow}
    />
  );
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

async function persistSessionBranch(
  sessionId: string | null,
  repo: {
    owner: { login: string };
    name: string;
    full_name: string;
  } | null,
  branch: string,
  switchBranch: (branchName: string) => void,
  isCurrentTarget: () => boolean,
): Promise<void> {
  if (!isCurrentTarget()) return;
  if (repo) await selectWorkspace(repo, branch);
  if (!isCurrentTarget()) return;
  if (sessionId && repo) saveSessionBranchPreference(sessionId, repo.full_name, branch);
  switchBranch(branch);
}
