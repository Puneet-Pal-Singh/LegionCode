import type { ApprovalRequest } from "@repo/shared-types";

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

export function buildApprovalQuestion(
  pendingApproval: ApprovalRequest,
): string {
  switch (pendingApproval.category) {
    case "git_mutation":
      return "Do you want me to change the Git repository?";
    case "filesystem_write":
      return "Do you want me to change workspace files?";
    case "network_external":
      return "Do you want me to access an external service?";
    case "deploy_or_infra_mutation":
      return "Do you want me to change deployment infrastructure?";
    case "shell_command":
      return "Do you want me to run a shell command?";
    default:
      return "Do you want me to continue with this action?";
  }
}
