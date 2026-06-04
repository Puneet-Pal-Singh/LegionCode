import { Check, ShieldCheck, X } from "lucide-react";
import type { ApprovalDecisionKind } from "@repo/shared-types";
import { formatApprovalDecisionLabel } from "./approvalDecisions";
import { approvalDecisionButtonClassName } from "./approvalStyles";

interface ApprovalActionsProps {
  decisions: ApprovalDecisionKind[];
  busyDecision: ApprovalDecisionKind | null;
  isResolutionPending: boolean;
  onResolve: (decision: ApprovalDecisionKind) => Promise<void>;
}

export function ApprovalActions({
  decisions,
  busyDecision,
  isResolutionPending,
  onResolve,
}: ApprovalActionsProps) {
  // The whole dock is single-flight: a click on any decision disables
  // every decision while the parent coroutine is awaiting the network.
  // The per-decision `busyDecision` is kept for styling continuity but
  // is treated as a global "any decision in flight" signal here so two
  // rapid clicks across different decisions cannot both fire.
  const isSubmittingDecision = busyDecision !== null;
  const isDisabled = isSubmittingDecision || isResolutionPending;

  return (
    <div className="flex flex-wrap gap-2">
      {decisions.map((decision) => (
        <button
          key={decision}
          type="button"
          disabled={isDisabled}
          onClick={() => void onResolve(decision)}
          className={approvalDecisionButtonClassName(decision)}
        >
          <ApprovalDecisionIcon decision={decision} />
          {formatApprovalDecisionLabel(decision)}
        </button>
      ))}
    </div>
  );
}

function ApprovalDecisionIcon({
  decision,
}: {
  decision: ApprovalDecisionKind;
}) {
  if (decision === "allow_for_run" || decision === "allow_persistent_rule") {
    return <ShieldCheck size={14} aria-hidden="true" />;
  }
  if (decision === "deny" || decision === "abort") {
    return <X size={14} aria-hidden="true" />;
  }
  return <Check size={14} aria-hidden="true" />;
}
