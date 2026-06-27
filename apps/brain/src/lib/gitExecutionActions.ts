const CANONICAL_GIT_ACTIONS = {
  status: "git_status",
  diff: "git_diff",
  stage: "git_stage",
  unstage: "git_unstage",
  commit: "git_commit",
  push: "git_push",
  git_clone: "git_clone",
  git_diff: "git_diff",
  git_commit: "git_commit",
  git_push: "git_push",
  git_create_pull_request: "git_create_pull_request",
  git_pull: "git_pull",
  git_fetch: "git_fetch",
  git_branch_create: "git_branch_create",
  git_branch_switch: "git_branch_switch",
  git_branch_list: "git_branch_list",
  git_stage: "git_stage",
  git_unstage: "git_unstage",
  git_status: "git_status",
} as const;

export function toCanonicalGitExecutionAction(action: string): string {
  return CANONICAL_GIT_ACTIONS[action as keyof typeof CANONICAL_GIT_ACTIONS] ?? action;
}
