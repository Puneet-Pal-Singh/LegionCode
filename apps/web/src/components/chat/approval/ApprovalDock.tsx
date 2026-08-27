import type { ApprovalDecisionKind, ApprovalRequest } from "@repo/shared-types";
import { ApprovalActions } from "./ApprovalActions";
import {
  buildApprovalCategoryLabel,
  buildApprovalQuestion,
} from "./approvalLabels";

interface ApprovalDockProps {
  pendingApproval: ApprovalRequest;
  decisions: ApprovalDecisionKind[];
  busyDecision: ApprovalDecisionKind | null;
  error: string | null;
  onResolve: (decision: ApprovalDecisionKind) => Promise<void>;
}

export function ApprovalDock({
  pendingApproval,
  decisions,
  busyDecision,
  error,
  onResolve,
}: ApprovalDockProps) {
  return (
    <div className="mx-auto mb-3 w-full max-w-3xl">
      <div
        data-testid="lifecycle-approval"
        className="overflow-hidden rounded-xl border border-zinc-700/80 bg-[#18181b] text-sm text-zinc-100 shadow-[0_18px_48px_rgba(0,0,0,0.45)]"
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-zinc-400">
          <span className="font-medium text-zinc-200">
            {buildApprovalCategoryLabel(pendingApproval)}
          </span>
          <span>Approval required</span>
        </div>
        <div className="space-y-3 px-4 py-4">
          <div>
            <p className="font-medium text-zinc-50">
              {buildApprovalQuestion(pendingApproval)}
            </p>
            <p className="mt-1 text-zinc-400">
              {pendingApproval.title}
            </p>
          </div>
          {pendingApproval.command ? (
            <pre className="max-h-32 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 font-mono leading-relaxed text-zinc-300">
              <code>{pendingApproval.command}</code>
            </pre>
          ) : null}
        </div>
        <div className="border-t border-zinc-800 px-4 py-3">
          <ApprovalActions
            decisions={decisions}
            busyDecision={busyDecision}
            onResolve={onResolve}
          />
          {error ? (
            <div role="alert">
              <p className="mt-3 text-xs text-red-300">{error}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
