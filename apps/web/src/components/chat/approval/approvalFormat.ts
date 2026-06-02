import type { ApprovalDecisionKind, ApprovalRequest } from "@repo/shared-types";

export const PRIMARY_APPROVAL_DECISIONS: ApprovalDecisionKind[] = [
  "allow_once",
  "allow_for_run",
  "deny",
];

export function getDisplayedApprovalDecisions(
  pendingApproval: ApprovalRequest | null,
): ApprovalDecisionKind[] {
  if (!pendingApproval) {
    return [];
  }

  const preferredDecisions = PRIMARY_APPROVAL_DECISIONS.filter((decision) =>
    pendingApproval.availableDecisions.includes(decision),
  );
  const remainingDecisions = pendingApproval.availableDecisions.filter(
    (decision) => !preferredDecisions.includes(decision),
  );
  return [...preferredDecisions, ...remainingDecisions];
}

export function formatApprovalDecisionLabel(
  decision: ApprovalDecisionKind,
): string {
  switch (decision) {
    case "allow_once":
      return "Allow once";
    case "allow_for_run":
      return "Allow for this run";
    case "allow_persistent_rule":
      return "Allow in future";
    case "deny":
      return "Deny";
    case "abort":
      return "Abort";
    default:
      return decision;
  }
}

export function approvalDecisionButtonClassName(
  decision: ApprovalDecisionKind,
): string {
  const baseClassName =
    "inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

  switch (decision) {
    case "allow_once":
      return `${baseClassName} border-blue-500/35 bg-blue-500/10 text-blue-100 hover:border-blue-400/50 hover:bg-blue-500/15`;
    case "allow_for_run":
      return `${baseClassName} border-emerald-500/35 bg-emerald-500/10 text-emerald-100 hover:border-emerald-400/50 hover:bg-emerald-500/15`;
    case "deny":
    case "abort":
      return `${baseClassName} border-red-500/35 bg-red-500/10 text-red-100 hover:border-red-400/50 hover:bg-red-500/15`;
    case "allow_persistent_rule":
    default:
      return `${baseClassName} border-zinc-600 bg-zinc-900/80 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800/80`;
  }
}

export function buildApprovalPromptTitle(
  pendingApproval: ApprovalRequest,
): string {
  const title = pendingApproval.title.trim();
  if (title.endsWith("?")) {
    return title;
  }

  const wantsToMatch = title.match(/^(?:legioncode)\s+wants\s+to\s+(.+)$/i);
  if (wantsToMatch?.[1]) {
    return `Do you want me to ${wantsToMatch[1]}?`;
  }

  return buildApprovalCategoryPrompt(pendingApproval.category);
}

export function buildApprovalCategoryLabel(
  pendingApproval: ApprovalRequest,
): string {
  switch (pendingApproval.category) {
    case "git_mutation":
      return "Git mutation";
    case "filesystem_write":
      return "Filesystem write";
    case "network_external":
      return "External network";
    case "outside_workspace":
      return "Outside workspace";
    case "subagent_spawn":
      return "Sub-agent";
    case "provider_connect":
      return "Provider connection";
    case "deploy_or_infra_mutation":
      return "Deploy or infrastructure";
    case "dangerous_retry":
      return "Risky retry";
    case "shell_command":
    default:
      return "Command approval";
  }
}

function buildApprovalCategoryPrompt(category: ApprovalRequest["category"]) {
  switch (category) {
    case "git_mutation":
      return "Do you want me to run this git command?";
    case "filesystem_write":
      return "Do you want me to write files in this workspace?";
    case "network_external":
      return "Do you want me to access an external network target?";
    case "outside_workspace":
      return "Do you want me to run this command outside the workspace?";
    case "subagent_spawn":
      return "Do you want me to start a sub-agent?";
    case "provider_connect":
      return "Do you want me to connect this provider?";
    case "deploy_or_infra_mutation":
      return "Do you want me to run this deployment action?";
    case "dangerous_retry":
      return "Do you want me to retry this risky action?";
    case "shell_command":
    default:
      return "Do you want me to run this command?";
  }
}
