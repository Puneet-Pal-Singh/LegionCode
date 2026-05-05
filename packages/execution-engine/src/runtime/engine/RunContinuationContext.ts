import type {
  AgenticLoopToolLifecycleEvent,
  RepositoryContext,
  RunGitTaskStrategyState,
  RunContinuationState,
  RunWorkspaceBootstrapState,
} from "../types.js";
import type { Run } from "../run/index.js";

const CONTINUATION_PROMPT_PATTERN =
  /^\s*(?:continue|continue\?|go on|resume|retry|try again|finish (?:it|that)|do it|same repo|pick up where you left off)\b/i;

export function createRunContinuationState(
  run: Run,
): RunContinuationState | undefined {
  const toolLifecycle = run.metadata.agenticLoop?.toolLifecycle ?? [];
  const restorableEdits = collectRestorableEdits(toolLifecycle);
  const completedFiles = [
    ...new Set(
      toolLifecycle.flatMap((event) =>
        event.status === "completed" && event.metadata?.family === "edit"
          ? [event.metadata.filePath]
          : [],
      ),
    ),
  ];
  const completedGitSteps = [
    ...new Set(
      toolLifecycle.flatMap((event) => {
        if (event.status !== "completed") {
          return [];
        }
        const summary = summarizeCompletedGitStep(event);
        return summary ? [summary] : [];
      }),
    ),
  ];
  const failedEvent = [...toolLifecycle]
    .reverse()
    .find((event) => event.status === "failed");
  const hasTrustedGitCommitIdentity =
    hasVerifiedGitHubProfileCommitIdentity(toolLifecycle);

  if (
    !run.metadata.prompt &&
    !run.output?.content &&
    completedFiles.length === 0 &&
    restorableEdits.length === 0 &&
    completedGitSteps.length === 0 &&
    !failedEvent
  ) {
    return undefined;
  }

  return {
    previousPrompt: run.metadata.prompt,
    previousOutput: run.output?.content,
    previousStopReason: run.metadata.agenticLoop?.stopReason,
    completedFiles,
    restorableEdits,
    completedGitSteps,
    hasTrustedGitCommitIdentity,
    activeBranch: resolveActiveBranch(run),
    failedToolName: failedEvent?.toolName,
    failedToolDetail: failedEvent?.detail,
    failedCommand:
      failedEvent?.metadata?.family === "shell"
        ? failedEvent.metadata.command
        : undefined,
    recordedAt: new Date().toISOString(),
  };
}

function collectRestorableEdits(
  toolLifecycle: AgenticLoopToolLifecycleEvent[] | undefined,
): Array<{ filePath: string; content: string }> {
  if (!toolLifecycle) {
    return [];
  }

  const latestByFile = new Map<string, { filePath: string; content: string }>();
  for (const event of toolLifecycle) {
    if (event.status !== "completed" || event.metadata?.family !== "edit") {
      continue;
    }
    const restorationContent = event.metadata.restorationContent;
    if (
      typeof event.metadata.filePath !== "string" ||
      event.metadata.filePath.trim().length === 0 ||
      typeof restorationContent !== "string"
    ) {
      continue;
    }
    latestByFile.set(event.metadata.filePath, {
      filePath: event.metadata.filePath,
      content: restorationContent,
    });
  }

  return Array.from(latestByFile.values());
}

export function buildAgenticLoopWorkspaceContext(input: {
  repositoryContext?: RepositoryContext;
  prompt: string;
  continuation?: RunContinuationState;
  workspaceBootstrap?: RunWorkspaceBootstrapState;
  gitTaskStrategy?: RunGitTaskStrategyState;
}): string | undefined {
  const lines = buildRepositoryContextLines(input.repositoryContext);
  appendWorkspaceBootstrapLines(lines, input.workspaceBootstrap);
  appendGitTaskStrategyLines(lines, input.gitTaskStrategy);
  const continuation = shouldApplyContinuationContext(
    input.prompt,
    input.continuation,
  )
    ? input.continuation
    : undefined;

  if (continuation) {
    lines.push(
      "Continuation context: This follow-up turn is on the same workspace state. Continue from the last completed work instead of restarting from scratch.",
    );
    lines.push(`Previous request: ${continuation.previousPrompt}`);

    if (continuation.completedFiles.length > 0) {
      lines.push(
        `Files already changed in the workspace: ${continuation.completedFiles.join(", ")}`,
      );
    }

    if (continuation.completedGitSteps.length > 0) {
      lines.push("Git progress already completed in this workspace:");
      for (const step of continuation.completedGitSteps) {
        lines.push(`- ${step}`);
      }
    }

    if (continuation.activeBranch) {
      lines.push(`Resume on branch: ${continuation.activeBranch}`);
    }

    if (continuation.failedToolName && continuation.failedToolDetail) {
      lines.push(
        `Last failed step: ${continuation.failedToolName} - ${summarizeLine(
          continuation.failedToolDetail,
        )}`,
      );
    }

    if (continuation.previousOutput) {
      lines.push(
        `Previous assistant summary: ${summarizeLine(continuation.previousOutput)}`,
      );
    }

    if (isGitShellFailure(continuation)) {
      lines.push(
        "Prefer shell/bash for local git recovery by default. Use typed git tools only when they simplify a structured step like stage/commit/push.",
      );
    }

    if (isPullRequestShellFailure(continuation)) {
      lines.push(
        "For pull-request metadata and checks, prefer connector reads first. Use github_pr_list to discover the active PR and avoid gh shell commands unless the user explicitly requested gh.",
      );
    }

    if (isNonFastForwardPushFailure(continuation)) {
      lines.push(
        "The previous push failed after the changes were already committed locally. A clean working tree does not mean the edits were lost.",
      );
      lines.push(
        "Do not recreate or recommit files. Sync the branch with git_pull and retry git_push. If the pull cannot fast-forward, stop and explain that manual branch reconciliation is needed.",
      );
    }

    if (
      isLocalDiffScopeDecisionFailure(continuation) &&
      !hasExplicitScopeResponse(input.prompt)
    ) {
      lines.push(
        "Local diff scope decision is still required. Ask the user once which exact files or target scope should be staged/committed/pushed before continuing git mutations.",
      );
    }

    lines.push(
      "Do not repeat successful inspection or rewrite already-updated files unless the current workspace proves the change is missing.",
    );
  }

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join("\n");
}

function buildRepositoryContextLines(
  repositoryContext: RepositoryContext | undefined,
): string[] {
  if (!repositoryContext) {
    return [];
  }

  const repoName =
    repositoryContext.owner && repositoryContext.repo
      ? `${repositoryContext.owner}/${repositoryContext.repo}`
      : (repositoryContext.repo ?? repositoryContext.owner);
  const lines: string[] = [];

  if (repoName) {
    lines.push(`Repository: ${repoName}`);
  }

  if (repositoryContext.branch) {
    lines.push(`Branch: ${repositoryContext.branch}`);
  }

  lines.push(
    "The checked-out workspace is the source of truth. Inspect the real tree and answer from observed files or git state.",
  );

  return lines;
}

function shouldApplyContinuationContext(
  prompt: string,
  continuation: RunContinuationState | undefined,
): continuation is RunContinuationState {
  if (!continuation) {
    return false;
  }

  return CONTINUATION_PROMPT_PATTERN.test(prompt.trim());
}

function summarizeLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 177)}...`;
}

function appendWorkspaceBootstrapLines(
  lines: string[],
  workspaceBootstrap: RunWorkspaceBootstrapState | undefined,
): void {
  if (!workspaceBootstrap) {
    return;
  }

  if (!workspaceBootstrap.requested) {
    lines.push(
      "Workspace bootstrap state: skipped (no repository context was selected for this turn).",
    );
    return;
  }

  const readiness = workspaceBootstrap.ready ? "ready" : "blocked";
  const modeSuffix = workspaceBootstrap.mode
    ? `, mode=${workspaceBootstrap.mode}`
    : "";
  lines.push(
    `Workspace bootstrap state: ${readiness} (status=${workspaceBootstrap.status}${modeSuffix}).`,
  );

  if (workspaceBootstrap.expectedMiss) {
    lines.push(
      "Bootstrap note: the last bootstrap miss is expected startup noise, not a generic platform failure.",
    );
  }

  if (workspaceBootstrap.message) {
    lines.push(`Latest bootstrap detail: ${summarizeLine(workspaceBootstrap.message)}`);
  }
}

function appendGitTaskStrategyLines(
  lines: string[],
  gitTaskStrategy: RunGitTaskStrategyState | undefined,
): void {
  if (!gitTaskStrategy) {
    return;
  }

  const fallbackSuffix = gitTaskStrategy.fallbackLane
    ? ` (fallback: ${gitTaskStrategy.fallbackLane})`
    : "";
  lines.push(
    `Git/GitHub strategy hint: ${gitTaskStrategy.classification} -> ${gitTaskStrategy.preferredLane}${fallbackSuffix}.`,
  );
  lines.push(`Strategy rationale: ${gitTaskStrategy.rationale}`);
}

function isGitShellFailure(continuation: RunContinuationState): boolean {
  return (
    continuation.failedToolName === "bash" &&
    typeof continuation.failedCommand === "string" &&
    /\bgit\b/.test(continuation.failedCommand)
  );
}

function isPullRequestShellFailure(
  continuation: RunContinuationState,
): boolean {
  return (
    continuation.failedToolName === "bash" &&
    typeof continuation.failedCommand === "string" &&
    /\bgh\s+pr\s+create\b/.test(continuation.failedCommand)
  );
}

function isNonFastForwardPushFailure(
  continuation: RunContinuationState,
): boolean {
  if (continuation.failedToolName !== "git_push") {
    return false;
  }

  const detail = continuation.failedToolDetail ?? "";
  return /non-fast-forward|tip of your current branch is behind|newer commits|already committed locally/i.test(
    detail,
  );
}

function isLocalDiffScopeDecisionFailure(
  continuation: RunContinuationState,
): boolean {
  if (
    continuation.failedToolName !== "git_stage" &&
    continuation.failedToolName !== "git_commit" &&
    continuation.failedToolName !== "git_push"
  ) {
    return false;
  }

  return /scope decision|diff scope|which files|target scope/i.test(
    continuation.failedToolDetail ?? "",
  );
}

function hasExplicitScopeResponse(prompt: string): boolean {
  return /\b(files?|scope|only|just|stage|commit|push)\b/i.test(prompt);
}

function summarizeCompletedGitStep(
  event: AgenticLoopToolLifecycleEvent,
): string | null {
  switch (event.toolName) {
    case "git_branch_create":
      return summarizeGitStep("Branch created", event.detail, event.metadata);
    case "git_commit":
      return summarizeGitStep("Commit created", event.detail, event.metadata);
    case "git_push":
      return summarizeGitStep("Branch pushed", event.detail, event.metadata);
    case "git_pull":
      return summarizeGitStep("Branch synced", event.detail, event.metadata);
    case "git_create_pull_request":
      return summarizeGitStep(
        "Pull request created",
        event.detail,
        event.metadata,
      );
    default:
      return null;
  }
}

function summarizeGitStep(
  label: string,
  detail: string | undefined,
  metadata: AgenticLoopToolLifecycleEvent["metadata"],
): string {
  const preview =
    metadata && "preview" in metadata && typeof metadata.preview === "string"
      ? summarizeLine(metadata.preview)
      : "";
  const normalizedDetail = detail ? summarizeLine(detail) : "";
  const suffix = preview || normalizedDetail;
  return suffix ? `${label}: ${suffix}` : label;
}

function hasVerifiedGitHubProfileCommitIdentity(
  toolLifecycle: AgenticLoopToolLifecycleEvent[],
): boolean {
  for (const event of [...toolLifecycle].reverse()) {
    if (event.status !== "completed" || event.toolName !== "git_commit") {
      continue;
    }
    if (event.metadata?.family !== "git") {
      continue;
    }
    return (
      event.metadata.commitIdentitySource === "github_profile" &&
      event.metadata.commitIdentityVerified === true
    );
  }

  return false;
}

function resolveActiveBranch(run: Run): string | undefined {
  const toolLifecycle = run.metadata.agenticLoop?.toolLifecycle ?? [];
  for (const event of [...toolLifecycle].reverse()) {
    if (event.status !== "completed") {
      continue;
    }
    const branch = readBranchFromLifecycleEvent(event);
    if (branch) {
      return branch;
    }
  }
  const repositoryBranch = run.input.repositoryContext?.branch?.trim();
  return repositoryBranch && repositoryBranch.length > 0
    ? repositoryBranch
    : undefined;
}

function readBranchFromLifecycleEvent(
  event: AgenticLoopToolLifecycleEvent,
): string | undefined {
  if (event.metadata?.family !== "git") {
    return undefined;
  }

  const directBranch = event.metadata.branch?.trim();
  if (directBranch) {
    return directBranch;
  }

  if (
    (event.toolName === "git_branch_create" ||
      event.toolName === "git_branch_switch" ||
      event.toolName === "git_pull" ||
      event.toolName === "git_push") &&
    typeof event.metadata.preview === "string"
  ) {
    const previewBranch = event.metadata.preview.trim();
    if (previewBranch.length > 0 && previewBranch !== "origin") {
      return previewBranch;
    }
  }

  return undefined;
}
