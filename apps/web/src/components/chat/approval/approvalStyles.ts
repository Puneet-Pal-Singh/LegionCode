import type { ApprovalDecisionKind } from "@repo/shared-types";

const APPROVAL_DECISION_BUTTON_CLASS_NAME =
  "inline-flex min-h-10 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";

export function approvalDecisionButtonClassName(
  decision: ApprovalDecisionKind,
): string {
  switch (decision) {
    case "allow_once":
      return `${APPROVAL_DECISION_BUTTON_CLASS_NAME} border-blue-500/35 bg-blue-500/10 text-blue-100 hover:border-blue-400/50 hover:bg-blue-500/15`;
    case "allow_for_run":
      return `${APPROVAL_DECISION_BUTTON_CLASS_NAME} border-emerald-500/35 bg-emerald-500/10 text-emerald-100 hover:border-emerald-400/50 hover:bg-emerald-500/15`;
    case "deny":
    case "abort":
      return `${APPROVAL_DECISION_BUTTON_CLASS_NAME} border-red-500/35 bg-red-500/10 text-red-100 hover:border-red-400/50 hover:bg-red-500/15`;
    case "allow_persistent_rule":
    default:
      return `${APPROVAL_DECISION_BUTTON_CLASS_NAME} border-zinc-600 bg-zinc-900/80 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800/80`;
  }
}
