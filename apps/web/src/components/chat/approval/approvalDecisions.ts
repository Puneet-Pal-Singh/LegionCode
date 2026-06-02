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
