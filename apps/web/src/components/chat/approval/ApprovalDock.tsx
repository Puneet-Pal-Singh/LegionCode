import type { ApprovalDecisionKind, ApprovalRequest } from "@repo/shared-types";
import { ApprovalActions } from "./ApprovalActions";
import { buildApprovalCategoryLabel } from "./approvalFormat";

interface ApprovalDockProps {
  pendingApproval: ApprovalRequest;
  decisions: ApprovalDecisionKind[];
  busyDecision: ApprovalDecisionKind | null;
  error: string | null;
  notice: string | null;
  isResolutionPending: boolean;
  onResolve: (decision: ApprovalDecisionKind) => Promise<void>;
}

export function ApprovalDock({
  pendingApproval,
  decisions,
  busyDecision,
  error,
  notice,
  isResolutionPending,
  onResolve,
}: ApprovalDockProps) {
  return (
    <div className="sticky top-0 z-20 -mx-1 mb-4 pt-1">
      <div className="rounded-xl border border-amber-300/35 bg-zinc-950/95 px-3 py-3 text-zinc-100 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-200">
              Approval required
              <span className="ml-2 normal-case tracking-normal text-zinc-400">
                {buildApprovalCategoryLabel(pendingApproval)}
              </span>
            </p>
            <p className="mt-1 truncate text-sm font-semibold text-zinc-100">
              {pendingApproval.title}
            </p>
            {pendingApproval.command ? (
              <p className="mt-1 truncate font-mono text-xs text-zinc-400">
                {pendingApproval.command}
              </p>
            ) : null}
          </div>
          <ApprovalActions
            decisions={decisions}
            busyDecision={busyDecision}
            isResolutionPending={isResolutionPending}
            onResolve={onResolve}
          />
        </div>
        {notice ? (
          <p className="mt-2 text-xs text-emerald-200">{notice}</p>
        ) : null}
        {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
      </div>
    </div>
  );
}
