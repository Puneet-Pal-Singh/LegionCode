import {
  APPROVAL_DECISION_KINDS,
  RISKY_ACTION_CATEGORIES,
  type ApprovalDecisionKind,
  type ApprovalRequest,
  type PermissionEvaluationResult,
  type ProductMode,
  type ProposedPersistentRule,
  type RiskyActionCategory,
  type WorkflowIntent,
} from "@repo/shared-types";
import type { GoldenFlowToolName } from "../contracts/CodingToolGateway.js";
import { PermissionApprovalStore } from "./PermissionApprovalStore.js";
import {
  requiresMutationForIntent,
  type CurrentTurnIntent,
} from "./RunCurrentTurnIntent.js";

const SHELL_NETWORK_PATTERN =
  /\b(curl|wget|npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install)\b/i;
const SHELL_DEPLOY_PATTERN =
  /\b(wrangler\s+deploy|terraform\s+apply|pulumi\s+up|kubectl\s+apply|serverless\s+deploy)\b/i;
const SHELL_DESTRUCTIVE_PATTERN =
  /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-fd|git\s+push\s+--force)\b/i;
const GIT_COMMIT_IDENTITY_CONFIG_SEGMENT_PATTERN =
  /\bgit(?:\s+-C\s+\S+)?\s+config\b.*\buser\.(?:name|email)\b/i;
const SAFE_PERSISTENT_SHELL_PREFIXES = new Set([
  "git",
  "pnpm",
  "npm",
  "yarn",
  "ls",
  "pwd",
  "cat",
  "rg",
  "echo",
  "vitest",
]);
const UNSAFE_INTERPRETER_PREFIXES = new Set([
  "bash",
  "sh",
  "zsh",
  "python",
  "python3",
  "node",
  "deno",
  "perl",
  "ruby",
]);
const BROAD_PERSISTENT_SHELL_PREFIXES = new Set(["git", "npm", "pnpm", "yarn"]);
const SHELL_PREFIX_VERB_TOKENS = new Set(["run", "exec", "dlx"]);
const APPROVAL_TTL_MS = 30 * 60 * 1000;
const DANGEROUS_RETRY_THRESHOLD = 3;

export interface RiskyActionEvaluationInput {
  runId: string;
  sessionId: string;
  origin: "user" | "agent";
  productMode: ProductMode;
  workflowIntent: WorkflowIntent;
  toolName: GoldenFlowToolName;
  toolArgs: Record<string, unknown>;
  currentTurnIntent?: CurrentTurnIntent;
  hasMutationEvidence: boolean;
  allowResumeGitPush?: boolean;
  ownerUserId?: string;
  approvalStore: PermissionApprovalStore;
}

export interface PermissionAskResult {
  kind: "ask";
  request: ApprovalRequest;
}

export interface PermissionDenyResult {
  kind: "deny";
  reason: string;
}

export type ToolPermissionGateResult =
  | { kind: "allow" }
  | PermissionAskResult
  | PermissionDenyResult;
type PolicyDecisionResult =
  | { kind: "allow" }
  | { kind: "ask" }
  | PermissionDenyResult;

interface ClassifiedRiskAction {
  category: RiskyActionCategory;
  title: string;
  reason: string;
  actionFingerprint: string;
  safeByDefault: boolean;
  command?: string;
  cwd?: string;
  affectedPaths?: string[];
  remoteTarget?: string;
  gitAction?: "stage" | "commit" | "push" | "pull";
  providerOperation?: "validate" | "connect";
  destructive: boolean;
}

export async function evaluateToolPermission(
  input: RiskyActionEvaluationInput,
): Promise<ToolPermissionGateResult> {
  const classified = classifyRiskAction(input.toolName, input.toolArgs);

  const mutationEvidenceDenial = getMutationEvidenceDenial(
    classified,
    input.toolName,
    input.currentTurnIntent,
    input.hasMutationEvidence,
    Boolean(input.allowResumeGitPush),
  );
  if (mutationEvidenceDenial) {
    return mutationEvidenceDenial;
  }

  if (await hasPreapprovedAction(input.approvalStore, classified)) {
    return { kind: "allow" };
  }

  const policyDecision = decidePolicyOutcome({
    origin: input.origin,
    productMode: input.productMode,
    workflowIntent: input.workflowIntent,
    classified,
  });
  if (policyDecision.kind !== "ask") {
    return policyDecision;
  }

  return await createApprovalAskResult(input, classified);
}

export function mapPermissionGateToEvaluationResult(
  result: ToolPermissionGateResult,
): PermissionEvaluationResult {
  if (result.kind === "allow") {
    return { kind: "allow" };
  }
  if (result.kind === "deny") {
    return { kind: "deny", reason: result.reason };
  }
  return { kind: "ask", request: result.request };
}

function requiresMutationEvidence(
  classified: ClassifiedRiskAction,
  toolName: GoldenFlowToolName,
  currentTurnIntent: CurrentTurnIntent | undefined,
): boolean {
  const mutationScopedTurn = currentTurnIntent
    ? requiresMutationForIntent(currentTurnIntent)
    : true;
  if (!mutationScopedTurn) {
    return false;
  }

  return (
    classified.category === RISKY_ACTION_CATEGORIES.GIT_MUTATION &&
    toolName === "git_push"
  );
}

function getMutationEvidenceDenial(
  classified: ClassifiedRiskAction,
  toolName: GoldenFlowToolName,
  currentTurnIntent: CurrentTurnIntent | undefined,
  hasMutationEvidence: boolean,
  allowResumeGitPush: boolean,
): PermissionDenyResult | null {
  if (toolName === "git_push" && allowResumeGitPush) {
    return null;
  }

  if (
    requiresMutationEvidence(classified, toolName, currentTurnIntent) &&
    !hasMutationEvidence
  ) {
    return {
      kind: "deny",
      reason:
        "LegionCode cannot continue with git push yet because no successful file mutation or committed-change evidence exists in this run.",
    };
  }

  return null;
}

async function hasPreapprovedAction(
  approvalStore: PermissionApprovalStore,
  classified: ClassifiedRiskAction,
): Promise<boolean> {
  const runApproved = await approvalStore.isActionAllowed(
    classified.actionFingerprint,
  );
  if (runApproved) {
    await approvalStore.clearRiskyAttempt(classified.actionFingerprint);
    return true;
  }

  const persistentApproved = await approvalStore.matchPersistentRule({
    category: classified.category,
    command: classified.command,
    gitAction:
      classified.gitAction === "stage" || classified.gitAction === "commit"
        ? classified.gitAction
        : undefined,
    providerOperation: classified.providerOperation,
  });
  if (persistentApproved) {
    await approvalStore.clearRiskyAttempt(classified.actionFingerprint);
    return true;
  }

  return false;
}

function classifyRiskAction(
  toolName: GoldenFlowToolName,
  toolArgs: Record<string, unknown>,
): ClassifiedRiskAction {
  const affectedPaths = extractCandidatePaths(toolArgs);
  const outsideWorkspace = affectedPaths.some(isOutsideWorkspacePath);
  if (outsideWorkspace) {
    return {
      category: RISKY_ACTION_CATEGORIES.OUTSIDE_WORKSPACE,
      title: "LegionCode wants to operate outside the workspace",
      reason:
        "This action targets a path outside the current workspace and requires explicit confirmation.",
      affectedPaths,
      actionFingerprint: buildActionFingerprint({
        category: RISKY_ACTION_CATEGORIES.OUTSIDE_WORKSPACE,
        toolName,
        toolArgs,
      }),
      safeByDefault: false,
      destructive: false,
    };
  }

  if (
    toolName === "read_file" ||
    toolName === "list_files" ||
    toolName === "glob" ||
    toolName === "grep" ||
    toolName === "language_diagnostics" ||
    toolName === "git_status" ||
    toolName === "git_diff" ||
    toolName === "github_pr_list" ||
    toolName === "github_pr_get" ||
    toolName === "github_pr_checks_get" ||
    toolName === "github_review_threads_get" ||
    toolName === "github_issue_get" ||
    toolName === "github_actions_run_get" ||
    toolName === "github_actions_job_logs_get" ||
    toolName === "github_cli_pr_checks_get" ||
    toolName === "github_cli_actions_run_get" ||
    toolName === "github_cli_actions_job_logs_get"
  ) {
    return {
      category: RISKY_ACTION_CATEGORIES.FILESYSTEM_WRITE,
      title: toolName.startsWith("github_")
        ? "LegionCode wants to inspect GitHub metadata"
        : "LegionCode wants to inspect repository state",
      reason: toolName.startsWith("github_")
        ? "This is a read-only connector metadata action and is allowed under the current policy."
        : "This is a read-only exploration action and is allowed under the current policy.",
      affectedPaths,
      actionFingerprint: buildActionFingerprint({
        category: RISKY_ACTION_CATEGORIES.FILESYSTEM_WRITE,
        toolName,
        toolArgs,
      }),
      safeByDefault: true,
      destructive: false,
    };
  }

  if (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "multi_edit" ||
    toolName === "apply_patch" ||
    toolName === "format_file"
  ) {
    return {
      category: RISKY_ACTION_CATEGORIES.FILESYSTEM_WRITE,
      title: "LegionCode wants to edit files",
      reason:
        "This action mutates workspace files and should be confirmed based on your permission mode.",
      affectedPaths,
      actionFingerprint: buildActionFingerprint({
        category: RISKY_ACTION_CATEGORIES.FILESYSTEM_WRITE,
        toolName,
        toolArgs,
      }),
      safeByDefault: false,
      destructive: false,
    };
  }

  if (toolName === "bash") {
    const command =
      typeof toolArgs.command === "string" ? toolArgs.command.trim() : "";
    const cwd = typeof toolArgs.cwd === "string" ? toolArgs.cwd.trim() : ".";
    const destructive = SHELL_DESTRUCTIVE_PATTERN.test(command);
    const deployLike = SHELL_DEPLOY_PATTERN.test(command);
    const networkLike = SHELL_NETWORK_PATTERN.test(command);

    const category = deployLike
      ? RISKY_ACTION_CATEGORIES.DEPLOY_OR_INFRA_MUTATION
      : networkLike
        ? RISKY_ACTION_CATEGORIES.NETWORK_EXTERNAL
        : RISKY_ACTION_CATEGORIES.SHELL_COMMAND;

    return {
      category,
      title: deployLike
        ? "LegionCode wants to run deployment or infrastructure changes"
        : networkLike
          ? "LegionCode wants to run a networked shell command"
          : "LegionCode wants to run a shell command",
      reason: destructive
        ? "This command appears destructive and needs explicit approval."
        : deployLike
          ? "This command can mutate remote infrastructure and should be confirmed."
          : networkLike
            ? "This command may mutate external state or install dependencies."
            : "Shell commands can change repository or environment state and should be confirmed.",
      command,
      cwd,
      actionFingerprint: buildActionFingerprint({
        category,
        toolName,
        toolArgs: { command, cwd },
      }),
      safeByDefault: false,
      destructive,
    };
  }

  if (
    toolName === "git_stage" ||
    toolName === "git_commit" ||
    toolName === "git_push" ||
    toolName === "git_pull" ||
    toolName === "git_create_pull_request" ||
    toolName === "git_branch_create" ||
    toolName === "git_branch_switch" ||
    toolName === "github_cli_pr_comment"
  ) {
    const gitAction = toGitAction(toolName);
    return {
      category: RISKY_ACTION_CATEGORIES.GIT_MUTATION,
      title: describeGitMutationTitle(toolName),
      reason:
        toolName === "github_cli_pr_comment"
          ? "Posting a pull request comment mutates remote GitHub state and requires explicit confirmation."
          : "Git mutation actions can change repository history and should be explicitly confirmed.",
      affectedPaths,
      remoteTarget: extractRemoteTarget(toolArgs),
      gitAction,
      actionFingerprint:
        toolName === "github_cli_pr_comment"
          ? buildGitHubPullRequestMutationFingerprint(toolArgs)
          : buildActionFingerprint({
              category: RISKY_ACTION_CATEGORIES.GIT_MUTATION,
              toolName,
              toolArgs,
            }),
      safeByDefault: false,
      destructive: toolName === "git_push",
    };
  }

  return {
    category: RISKY_ACTION_CATEGORIES.FILESYSTEM_WRITE,
    title: "LegionCode wants to run a mutating action",
    reason: "This action mutates workspace state and requires confirmation.",
    actionFingerprint: buildActionFingerprint({
      category: RISKY_ACTION_CATEGORIES.FILESYSTEM_WRITE,
      toolName,
      toolArgs,
    }),
    safeByDefault: false,
    destructive: false,
  };
}

function decidePolicyOutcome(input: {
  origin: "user" | "agent";
  productMode: ProductMode;
  workflowIntent: WorkflowIntent;
  classified: ClassifiedRiskAction;
}): PolicyDecisionResult {
  const { origin, productMode, workflowIntent, classified } = input;
  const disallowedShellReason = getDisallowedShellReason(origin, classified);
  if (disallowedShellReason) {
    return {
      kind: "deny",
      reason: disallowedShellReason,
    };
  }
  const guaranteedDecision = getGuaranteedDecision(classified);
  if (guaranteedDecision) {
    return guaranteedDecision;
  }

  const workflowDecision = getWorkflowDecision(workflowIntent);
  if (workflowDecision) {
    return workflowDecision;
  }

  return getProductModeDecision(productMode, classified);
}

function getGuaranteedDecision(
  classified: ClassifiedRiskAction,
): PolicyDecisionResult | null {
  if (classified.safeByDefault) {
    return { kind: "allow" };
  }
  if (classified.category === RISKY_ACTION_CATEGORIES.DANGEROUS_RETRY) {
    return { kind: "ask" };
  }
  if (classified.category === RISKY_ACTION_CATEGORIES.OUTSIDE_WORKSPACE) {
    return { kind: "ask" };
  }
  if (classified.destructive) {
    return { kind: "ask" };
  }
  return null;
}

function getWorkflowDecision(
  workflowIntent: WorkflowIntent,
): { kind: "ask" } | null {
  if (workflowIntent === "review" || workflowIntent === "explore") {
    return { kind: "ask" };
  }
  return null;
}

function getProductModeDecision(
  productMode: ProductMode,
  classified: ClassifiedRiskAction,
): PolicyDecisionResult {
  switch (productMode) {
    case "ask_always":
      return { kind: "ask" };
    case "auto_for_safe":
      return isAutoForSafeCategory(classified.category)
        ? { kind: "ask" }
        : { kind: "allow" };
    case "auto_for_same_repo":
      return isSameRepoApprovalCategory(classified.category)
        ? { kind: "ask" }
        : { kind: "allow" };
    case "full_agent":
      return isFullAgentApprovalCategory(classified.category)
        ? { kind: "ask" }
        : { kind: "allow" };
    default:
      return {
        kind: "deny",
        reason: "Unknown product mode. Refusing to run mutating action.",
      };
  }
}

function isAutoForSafeCategory(category: RiskyActionCategory): boolean {
  return isSameRepoApprovalCategory(category);
}

function isSameRepoApprovalCategory(category: RiskyActionCategory): boolean {
  return (
    category === RISKY_ACTION_CATEGORIES.GIT_MUTATION ||
    category === RISKY_ACTION_CATEGORIES.SHELL_COMMAND ||
    category === RISKY_ACTION_CATEGORIES.NETWORK_EXTERNAL ||
    category === RISKY_ACTION_CATEGORIES.DEPLOY_OR_INFRA_MUTATION
  );
}

function isFullAgentApprovalCategory(category: RiskyActionCategory): boolean {
  return (
    category === RISKY_ACTION_CATEGORIES.GIT_MUTATION ||
    category === RISKY_ACTION_CATEGORIES.NETWORK_EXTERNAL ||
    category === RISKY_ACTION_CATEGORIES.DEPLOY_OR_INFRA_MUTATION
  );
}

async function createApprovalAskResult(
  input: RiskyActionEvaluationInput,
  classified: ClassifiedRiskAction,
): Promise<PermissionAskResult> {
  const attemptCount = await input.approvalStore.registerRiskyAttempt(
    classified.actionFingerprint,
    classified.reason,
  );
  const category =
    attemptCount >= DANGEROUS_RETRY_THRESHOLD
      ? RISKY_ACTION_CATEGORIES.DANGEROUS_RETRY
      : classified.category;
  const proposedPersistentRule = buildProposedPersistentRule(
    classified,
    input.toolName,
  );
  const request = await input.approvalStore.setPendingRequest(
    {
      requestId: crypto.randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      origin: input.origin,
      category,
      title: getApprovalTitle(category, classified),
      reason: getApprovalReason(category, classified),
      command: classified.command,
      cwd: classified.cwd,
      affectedPaths: classified.affectedPaths,
      remoteTarget: classified.remoteTarget,
      actionFingerprint: classified.actionFingerprint,
      availableDecisions: buildAvailableDecisions(
        category,
        Boolean(proposedPersistentRule),
      ),
      proposedPersistentRule: proposedPersistentRule ?? undefined,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    },
    input.ownerUserId,
  );
  return { kind: "ask", request };
}

function getApprovalTitle(
  category: RiskyActionCategory,
  classified: ClassifiedRiskAction,
): string {
  return category === RISKY_ACTION_CATEGORIES.DANGEROUS_RETRY
    ? "LegionCode paused repeated risky retries"
    : classified.title;
}

function getApprovalReason(
  category: RiskyActionCategory,
  classified: ClassifiedRiskAction,
): string {
  return category === RISKY_ACTION_CATEGORIES.DANGEROUS_RETRY
    ? "The same risky action was attempted repeatedly without progress. Confirm how to proceed."
    : classified.reason;
}

function buildAvailableDecisions(
  category: RiskyActionCategory,
  hasPersistentRule: boolean,
) {
  const decisions: ApprovalDecisionKind[] = [
    APPROVAL_DECISION_KINDS.ALLOW_ONCE,
    APPROVAL_DECISION_KINDS.ALLOW_FOR_RUN,
  ];
  if (hasPersistentRule) {
    decisions.push(APPROVAL_DECISION_KINDS.ALLOW_PERSISTENT_RULE);
  }
  decisions.push(APPROVAL_DECISION_KINDS.DENY);
  if (
    category === RISKY_ACTION_CATEGORIES.DANGEROUS_RETRY ||
    category === RISKY_ACTION_CATEGORIES.DEPLOY_OR_INFRA_MUTATION
  ) {
    decisions.push(APPROVAL_DECISION_KINDS.ABORT);
  }
  return decisions;
}

function buildProposedPersistentRule(
  classified: ClassifiedRiskAction,
  toolName: GoldenFlowToolName,
): ProposedPersistentRule | null {
  if (classified.category === RISKY_ACTION_CATEGORIES.SHELL_COMMAND) {
    if (!classified.command) {
      return null;
    }
    const prefixTokens = buildShellPersistentPrefixTokens(classified.command);
    if (!prefixTokens) {
      return null;
    }
    return {
      category: "shell_command",
      prefixTokens,
      cwdScope: "current_repo",
      networkAccess: "none",
    };
  }

  if (classified.category === RISKY_ACTION_CATEGORIES.GIT_MUTATION) {
    if (toolName !== "git_stage" && toolName !== "git_commit") {
      return null;
    }
    return {
      category: "git_mutation",
      allowedActions: [toolName === "git_stage" ? "stage" : "commit"],
      repoScope: "current_repo",
    };
  }

  return null;
}

function buildActionFingerprint(input: {
  category: RiskyActionCategory;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): string {
  return `${input.category}:${input.toolName}:${stableStringify(input.toolArgs)}`;
}

function getDisallowedShellReason(
  origin: "user" | "agent",
  classified: ClassifiedRiskAction,
): string | null {
  if (origin !== "agent") {
    return null;
  }
  if (classified.category !== RISKY_ACTION_CATEGORIES.SHELL_COMMAND) {
    return null;
  }
  if (!classified.command) {
    return null;
  }
  const commandSegments = classified.command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const hasCommitIdentityConfigSegment = commandSegments.some((segment) =>
    GIT_COMMIT_IDENTITY_CONFIG_SEGMENT_PATTERN.test(segment),
  );
  if (!hasCommitIdentityConfigSegment) {
    return null;
  }
  return "Do not run git config user.name/user.email through shell. Use git_commit with authorName and authorEmail, or retry commit from the Git commit dialog so OAuth-backed identity is applied.";
}

function buildShellPersistentPrefixTokens(command: string): string[] | null {
  const tokens = command
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const [first, second, third] = tokens;
  if (!first) {
    return null;
  }
  if (UNSAFE_INTERPRETER_PREFIXES.has(first)) {
    return null;
  }
  if (!SAFE_PERSISTENT_SHELL_PREFIXES.has(first)) {
    return null;
  }
  if (!BROAD_PERSISTENT_SHELL_PREFIXES.has(first)) {
    return [first];
  }
  if (!isSafeShellPrefixToken(second)) {
    return null;
  }
  if (SHELL_PREFIX_VERB_TOKENS.has(second)) {
    return isSafeShellPrefixToken(third) ? [first, second, third] : null;
  }
  return [first, second];
}

function isSafeShellPrefixToken(token: string | undefined): token is string {
  return typeof token === "string" && /^[a-z0-9._:-]+$/.test(token);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([leftKey], [rightKey]) => leftKey.localeCompare(rightKey),
  );
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
    )
    .join(",")}}`;
}

function extractCandidatePaths(toolArgs: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const directPath = toolArgs.path;
  if (typeof directPath === "string" && directPath.trim()) {
    candidates.push(directPath.trim());
  }
  const cwd = toolArgs.cwd;
  if (typeof cwd === "string" && cwd.trim()) {
    candidates.push(cwd.trim());
  }
  const files = toolArgs.files;
  if (Array.isArray(files)) {
    for (const file of files) {
      if (typeof file === "string" && file.trim()) {
        candidates.push(file.trim());
      }
    }
  }
  const edits = toolArgs.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") {
        continue;
      }
      const editPath = (edit as Record<string, unknown>).path;
      if (typeof editPath === "string" && editPath.trim()) {
        candidates.push(editPath.trim());
      }
    }
  }
  const patch = toolArgs.patch;
  if (typeof patch === "string") {
    candidates.push(...extractPatchPaths(patch));
  }
  return candidates;
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match?.[1] && match[1] !== "/dev/null") {
      paths.add(match[1]);
    }
  }
  return [...paths];
}

function isOutsideWorkspacePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("..") ||
    path.includes("/../") ||
    path.includes("\\..\\")
  );
}

function toGitAction(
  toolName: GoldenFlowToolName,
): "stage" | "commit" | "push" | "pull" | undefined {
  if (toolName === "git_stage") {
    return "stage";
  }
  if (toolName === "git_commit") {
    return "commit";
  }
  if (toolName === "git_push") {
    return "push";
  }
  if (toolName === "git_pull") {
    return "pull";
  }
  return undefined;
}

function describeGitMutationTitle(toolName: GoldenFlowToolName): string {
  if (toolName === "git_stage") {
    return "LegionCode wants to stage repository changes";
  }
  if (toolName === "git_commit") {
    return "LegionCode wants to commit repository changes";
  }
  if (toolName === "git_push") {
    return "LegionCode wants to push repository changes";
  }
  if (toolName === "git_pull") {
    return "LegionCode wants to pull from remote";
  }
  if (toolName === "git_create_pull_request") {
    return "LegionCode wants to create a pull request";
  }
  if (toolName === "git_branch_create") {
    return "LegionCode wants to create a branch";
  }
  if (toolName === "git_branch_switch") {
    return "LegionCode wants to switch branches";
  }
  if (toolName === "github_cli_pr_comment") {
    return "LegionCode wants to comment on a pull request";
  }
  return "LegionCode wants to mutate git state";
}

function extractRemoteTarget(
  toolArgs: Record<string, unknown>,
): string | undefined {
  const owner = typeof toolArgs.owner === "string" ? toolArgs.owner.trim() : "";
  const repo = typeof toolArgs.repo === "string" ? toolArgs.repo.trim() : "";
  if (owner && repo) {
    return `${owner}/${repo}`;
  }
  const remote =
    typeof toolArgs.remote === "string" ? toolArgs.remote.trim() : "";
  if (remote) {
    return remote;
  }
  return undefined;
}

function buildGitHubPullRequestMutationFingerprint(
  toolArgs: Record<string, unknown>,
): string {
  const owner = typeof toolArgs.owner === "string" ? toolArgs.owner.trim() : "";
  const repo = typeof toolArgs.repo === "string" ? toolArgs.repo.trim() : "";
  const number =
    typeof toolArgs.number === "number" && Number.isFinite(toolArgs.number)
      ? Math.trunc(toolArgs.number)
      : null;
  const body =
    typeof toolArgs.body === "string"
      ? normalizePullRequestCommentBody(toolArgs.body)
      : "";
  const target = owner && repo ? `${owner}/${repo}` : "unknown";
  const prTarget = number && number > 0 ? `pr:${number}` : "pr:unknown";
  const bodyDigest = `body:${hashPullRequestCommentBody(body)}`;
  return `${RISKY_ACTION_CATEGORIES.GIT_MUTATION}:github_cli_pr_comment:${target}:${prTarget}:${bodyDigest}`;
}

function normalizePullRequestCommentBody(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hashPullRequestCommentBody(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, "0");
}
