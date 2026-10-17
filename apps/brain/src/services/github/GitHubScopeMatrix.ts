interface GitHubScopeRequirement {
  capability:
    | "baseline_repo_access"
    | "actions_read_access"
    | "pr_comment_write";
  requiredAnyOf: string[];
  rationale: string;
}

interface ScopeBoundaryInput {
  plugin: string;
  action: string;
  persistedScopes: string[] | null;
}

export interface GitHubScopeBoundary {
  capability: GitHubScopeRequirement["capability"];
  requiredAnyOf: string[];
  grantedScopes: string[];
  rationale: string;
}

const BASELINE_REPO_REQUIREMENT: GitHubScopeRequirement = {
  capability: "baseline_repo_access",
  requiredAnyOf: ["repo", "public_repo"],
  rationale:
    "Repository metadata reads and pull-request reads require baseline repository OAuth scope.",
};

const ACTIONS_READ_REQUIREMENT: GitHubScopeRequirement = {
  capability: "actions_read_access",
  requiredAnyOf: ["repo", "workflow", "actions:read"],
  rationale:
    "Actions run and log retrieval require repository + actions-read authorization.",
};

const PR_COMMENT_WRITE_REQUIREMENT: GitHubScopeRequirement = {
  capability: "pr_comment_write",
  requiredAnyOf: ["repo", "public_repo"],
  rationale:
    "Pull-request commenting requires write permission for PR conversation surfaces.",
};

export function parseGitHubScopeList(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    const normalized = raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    return normalized.length > 0 ? dedupeScopes(normalized) : [];
  }

  if (typeof raw !== "string") {
    return null;
  }

  const normalized = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 ? dedupeScopes(normalized) : [];
}

export function resolveGitHubScopeBoundary(
  input: ScopeBoundaryInput,
): GitHubScopeBoundary | null {
  if (input.persistedScopes === null) {
    return null;
  }

  const requirement = getGitHubScopeRequirement(input.plugin, input.action);
  if (!requirement) {
    return null;
  }

  if (hasAnyScope(input.persistedScopes, requirement.requiredAnyOf)) {
    return null;
  }

  return {
    capability: requirement.capability,
    requiredAnyOf: [...requirement.requiredAnyOf],
    grantedScopes: [...input.persistedScopes],
    rationale: requirement.rationale,
  };
}

export function describeGitHubScopeBoundaryError(
  plugin: string,
  action: string,
  boundary: GitHubScopeBoundary,
): string {
  const required = boundary.requiredAnyOf.join(", ");
  const granted =
    boundary.grantedScopes.length > 0
      ? boundary.grantedScopes.join(", ")
      : "none";
  return `Missing GitHub OAuth scope for ${plugin}:${action}. Required one of [${required}], but session grant has [${granted}]. Reconnect GitHub with the required scopes and retry.`;
}

function getGitHubScopeRequirement(
  plugin: string,
  action: string,
): GitHubScopeRequirement | null {
  if (
    (plugin === "github" || plugin === "github_cli") &&
    (action === "pr_get" ||
      action === "pr_list" ||
      action === "pr_files_get" ||
      action === "pr_checks_get" ||
      action === "review_threads_get" ||
      action === "issue_get")
  ) {
    return BASELINE_REPO_REQUIREMENT;
  }

  if (
    (plugin === "github" || plugin === "github_cli") &&
    (action === "actions_run_get" || action === "actions_job_logs_get")
  ) {
    return ACTIONS_READ_REQUIREMENT;
  }

  if (plugin === "github_cli" && action === "pr_comment") {
    return PR_COMMENT_WRITE_REQUIREMENT;
  }

  return null;
}

function hasAnyScope(
  grantedScopes: string[],
  requiredAnyOf: string[],
): boolean {
  const granted = new Set(grantedScopes.map((scope) => scope.toLowerCase()));
  for (const requiredScope of requiredAnyOf) {
    if (granted.has(requiredScope.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function dedupeScopes(scopes: string[]): string[] {
  return [...new Set(scopes)];
}
