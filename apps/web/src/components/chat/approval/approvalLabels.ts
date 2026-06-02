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
