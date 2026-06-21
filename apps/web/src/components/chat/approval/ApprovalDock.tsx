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
    <div className="mb-3">
      <div className="overflow-hidden rounded-xl border border-zinc-700/80 bg-[#18181b] text-zinc-100 shadow-[0_18px_48px_rgba(0,0,0,0.5)]">
        <div className="border-b border-zinc-800 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-300">
            Pending approval
            <span className="ml-3 normal-case tracking-normal text-zinc-400">
              {buildApprovalCategoryLabel(pendingApproval)} requested
            </span>
          </p>
        </div>
        <div className="space-y-4 px-4 py-5">
          <div>
            <p className="text-lg font-semibold text-zinc-50">
              {buildApprovalQuestion(pendingApproval)}
            </p>
            <p className="mt-2 text-sm text-zinc-400">
              {pendingApproval.title}
            </p>
          </div>
          {pendingApproval.command ? (
            <pre className="max-h-36 overflow-auto rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 font-mono text-sm leading-relaxed text-zinc-100">
              <code>{pendingApproval.command}</code>
            </pre>
          ) : null}
        </div>
        <div className="border-t border-zinc-800 px-4 py-4">
          <ApprovalActions
            decisions={decisions}
            busyDecision={busyDecision}
            isResolutionPending={isResolutionPending}
            onResolve={onResolve}
          />
          {notice ? (
            <div role="status" aria-live="polite">
              <p className="mt-3 text-xs text-emerald-200">{notice}</p>
            </div>
          ) : null}
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
