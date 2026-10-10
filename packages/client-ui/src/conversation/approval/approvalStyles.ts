import type { ApprovalDecisionKind } from "@repo/shared-types";

const APPROVAL_DECISION_BUTTON_CLASS_NAME =
  "inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

export function approvalDecisionButtonClassName(
  decision: ApprovalDecisionKind,
): string {
  switch (decision) {
    case "allow_once":
      return `${APPROVAL_DECISION_BUTTON_CLASS_NAME} border-zinc-100 bg-zinc-100 text-zinc-950 hover:bg-white`;
    case "allow_for_run":
      return `${APPROVAL_DECISION_BUTTON_CLASS_NAME} border-zinc-600 bg-zinc-800 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-700`;
    case "deny":
    case "abort":
      return `${APPROVAL_DECISION_BUTTON_CLASS_NAME} border-zinc-700 bg-transparent text-zinc-300 hover:border-zinc-500 hover:text-white`;
    case "allow_persistent_rule":
    default:
      return `${APPROVAL_DECISION_BUTTON_CLASS_NAME} border-zinc-600 bg-zinc-900/80 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800/80`;
  }
}
