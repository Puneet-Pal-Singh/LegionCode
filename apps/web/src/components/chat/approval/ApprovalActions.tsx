import { Check, ShieldCheck, X } from "lucide-react";
import type { ApprovalDecisionKind } from "@repo/shared-types";
import {
  approvalDecisionButtonClassName,
  formatApprovalDecisionLabel,
} from "./approvalFormat";

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
  const isDisabled = busyDecision !== null || isResolutionPending;

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
