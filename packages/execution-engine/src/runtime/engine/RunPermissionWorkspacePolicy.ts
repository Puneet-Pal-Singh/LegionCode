import type {
  RepositoryContext,
  WorkspaceBootstrapMode,
  WorkspaceBootstrapResult,
  WorkspaceBootstrapStatus,
  WorkspaceBootstrapper,
} from "../types.js";
import type { PermissionApprovalStore } from "./PermissionApprovalStore.js";
import {
  detectCrossRepoTarget,
  formatCrossRepoApprovalGrantedMessage,
  formatCrossRepoApprovalMessage,
  formatDestructiveApprovalGrantedMessage,
  formatDestructiveApprovalMessage,
  getSelectedRepoRef,
  isDestructiveActionPrompt,
  parsePermissionApprovalDirective,
} from "./RepositoryPermissionPolicy.js";
import { hasRepositorySelection } from "./ConversationPolicy.js";
import { resolveWorkspaceBootstrapMode } from "./WorkspaceBootstrapModePolicy.js";

export interface WorkspaceBootstrapEvaluation {
  mode?: WorkspaceBootstrapMode;
  status: WorkspaceBootstrapStatus | "skipped";
  message: string | null;
  blocked: boolean;
  expectedMiss: boolean;
  clonedDuringBootstrap: boolean;
}

export async function processPermissionDirectives(
  prompt: string,
  permissionApprovalStore: PermissionApprovalStore,
): Promise<string | null> {
  const directive = parsePermissionApprovalDirective(prompt);
  if (!directive.isApprovalOnlyPrompt) {
    return null;
  }

  const approvalMessages: string[] = [];

  if (directive.crossRepo) {
    await permissionApprovalStore.grantCrossRepo(
      directive.crossRepo.repoRef,
      directive.crossRepo.ttlMs,
    );
    approvalMessages.push(
      formatCrossRepoApprovalGrantedMessage(
        directive.crossRepo.repoRef,
        directive.crossRepo.ttlMs,
      ),
    );
  }

  if (directive.destructive) {
    await permissionApprovalStore.grantDestructive(directive.destructive.ttlMs);
    approvalMessages.push(
      formatDestructiveApprovalGrantedMessage(directive.destructive.ttlMs),
    );
  }

  if (approvalMessages.length === 0) {
    return null;
  }

  return `${approvalMessages.join(" ")} Re-send your repository action to continue.`;
}

export async function getPermissionPolicyMessage(
  prompt: string,
  repositoryContext: RepositoryContext | undefined,
  permissionApprovalStore: PermissionApprovalStore,
): Promise<string | null> {
  const selectedRepoRef = getSelectedRepoRef(repositoryContext);
  const crossRepoTarget = detectCrossRepoTarget(prompt, selectedRepoRef);

  if (crossRepoTarget) {
    const allowed = await permissionApprovalStore.hasCrossRepo(crossRepoTarget);
    if (!allowed) {
      return formatCrossRepoApprovalMessage(crossRepoTarget, selectedRepoRef);
    }
  }

  if (isDestructiveActionPrompt(prompt)) {
    const allowed = await permissionApprovalStore.hasDestructive();
    if (!allowed) {
      return formatDestructiveApprovalMessage();
    }
  }

  return null;
}

export async function getWorkspaceBootstrapMessage(
  runId: string,
  prompt: string,
  repositoryContext: RepositoryContext | undefined,
  workspaceBootstrapper: WorkspaceBootstrapper | undefined,
): Promise<string | null> {
  const evaluation = await evaluateWorkspaceBootstrap(
    runId,
    prompt,
    repositoryContext,
    workspaceBootstrapper,
  );
  return evaluation.message;
}

export async function evaluateWorkspaceBootstrap(
  runId: string,
  prompt: string,
  repositoryContext: RepositoryContext | undefined,
  workspaceBootstrapper: WorkspaceBootstrapper | undefined,
): Promise<WorkspaceBootstrapEvaluation> {
  if (!repositoryContext || !workspaceBootstrapper) {
    return {
      status: "skipped",
      message: null,
      blocked: false,
      expectedMiss: false,
      clonedDuringBootstrap: false,
    };
  }

  if (!hasRepositorySelection(repositoryContext)) {
    return {
      status: "invalid-context",
      message:
        "I need a valid repository selection before I can run repository actions. Please reselect the repository and try again.",
      blocked: true,
      expectedMiss: false,
      clonedDuringBootstrap: false,
    };
  }

  try {
    const bootstrapMode = resolveWorkspaceBootstrapMode(prompt);
    const bootstrapResult = await workspaceBootstrapper.bootstrap({
      runId,
      repositoryContext,
      mode: bootstrapMode,
    });
    const message = mapBootstrapResultToMessage(bootstrapResult, repositoryContext);
    return {
      mode: bootstrapMode,
      status: bootstrapResult.status,
      message,
      blocked: message !== null,
      expectedMiss: isExpectedBootstrapMiss(bootstrapResult.message),
      clonedDuringBootstrap: bootstrapResult.clonedDuringBootstrap ?? false,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "workspace bootstrap failed";
    const repoRef = describeRepositoryRef(repositoryContext);
    const message = `I couldn't prepare the workspace for ${repoRef}. ${errorMessage}`;
    return {
      mode: resolveWorkspaceBootstrapMode(prompt),
      status: "sync-failed",
      message,
      blocked: true,
      expectedMiss: isExpectedBootstrapMiss(errorMessage),
      clonedDuringBootstrap: false,
    };
  }
}

function mapBootstrapResultToMessage(
  bootstrapResult: WorkspaceBootstrapResult,
  repositoryContext: RepositoryContext,
): string | null {
  if (bootstrapResult.status === "ready") {
    return null;
  }

  if (bootstrapResult.status === "needs-auth") {
    return (
      bootstrapResult.message ??
      "I need GitHub authorization before I can access this repository. Please reconnect GitHub and try again."
    );
  }

  if (bootstrapResult.status === "invalid-context") {
    return (
      bootstrapResult.message ??
      "I need valid repository details (owner, repository, branch) before I can continue."
    );
  }

  const repoRef = describeRepositoryRef(repositoryContext);
  const reason =
    bootstrapResult.message ??
    "Repository sync failed. Please confirm the branch exists and retry.";
  const branchSwitchConflictMessage = mapBranchSwitchConflictMessage({
    reason,
    branch: repositoryContext.branch,
    repoRef,
  });
  if (branchSwitchConflictMessage) {
    return branchSwitchConflictMessage;
  }
  const transientBootstrapMessage = mapTransientBootstrapFailureMessage(
    reason,
    repoRef,
  );
  if (transientBootstrapMessage) {
    return transientBootstrapMessage;
  }
  return `I couldn't prepare the workspace for ${repoRef}. ${reason}`;
}

function describeRepositoryRef(repositoryContext: RepositoryContext): string {
  const owner = repositoryContext.owner?.trim() || "unknown-owner";
  const repo = repositoryContext.repo?.trim() || "unknown-repo";
  const branch = repositoryContext.branch?.trim();
  return branch ? `${owner}/${repo}@${branch}` : `${owner}/${repo}`;
}

function isExpectedBootstrapMiss(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return /not a git repository/i.test(message);
}

function mapTransientBootstrapFailureMessage(
  reason: string,
  repoRef: string,
): string | null {
  if (!isTransientBootstrapFailure(reason)) {
    return null;
  }
  return `I couldn't prepare the workspace for ${repoRef} because the git service is temporarily unavailable. Please retry in a few seconds.`;
}

function isTransientBootstrapFailure(reason: string): boolean {
  return (
    /network connection lost/i.test(reason) ||
    /failed to fetch/i.test(reason) ||
    /service unavailable/i.test(reason) ||
    /timed out/i.test(reason) ||
    /econnrefused/i.test(reason) ||
    /upstream connect error/i.test(reason) ||
    /sandboxerror:\s*http error!\s*status:\s*5\d\d/i.test(reason) ||
    /http error!\s*status:\s*5\d\d/i.test(reason) ||
    /failed with http 5\d\d/i.test(reason) ||
    /couldn't find a local dev session/i.test(reason) ||
    /entrypoint of service .* to proxy to/i.test(reason)
  );
}

function mapBranchSwitchConflictMessage(input: {
  reason: string;
  branch?: string;
  repoRef: string;
}): string | null {
  if (!/would be overwritten by checkout/i.test(input.reason)) {
    return null;
  }

  const branch = input.branch?.trim();
  const targetLabel =
    branch && branch.length > 0 ? `\`${branch}\`` : "the selected branch";
  const conflictedFiles = extractCheckoutConflictFiles(input.reason);
  const conflictedFilesSummary =
    conflictedFiles.length > 0
      ? `Conflicting file(s): ${conflictedFiles.join(", ")}.`
      : "Git reported local edits would be overwritten by checkout.";

  return [
    `I couldn't prepare the workspace for ${input.repoRef} because switching to ${targetLabel} would overwrite local changes.`,
    conflictedFilesSummary,
    "No local edits were discarded.",
    "Commit or stash those edits first, then retry the action.",
  ].join(" ");
}

function extractCheckoutConflictFiles(reason: string): string[] {
  const normalized = reason.replace(/\\n/g, "\n");
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const checkoutIndex = lines.findIndex((line) =>
    /would be overwritten by checkout:/i.test(line),
  );
  if (checkoutIndex === -1) {
    return [];
  }

  const files: string[] = [];
  for (const line of lines.slice(checkoutIndex + 1)) {
    if (/^please commit your changes/i.test(line) || /^aborting$/i.test(line)) {
      break;
    }
    const normalizedFile = line.replace(/^['"+\s\t]+|['"]+$/g, "").trim();
    if (normalizedFile.length > 0) {
      files.push(normalizedFile);
    }
  }

  return files;
}
