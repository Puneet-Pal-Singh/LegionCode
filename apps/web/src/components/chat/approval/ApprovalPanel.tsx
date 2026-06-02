import type { ApprovalRequest } from "@repo/shared-types";
import {
  buildApprovalCategoryLabel,
  buildApprovalPromptTitle,
} from "./approvalFormat";

interface ApprovalPanelProps {
  pendingApproval: ApprovalRequest;
}

export function ApprovalPanel({ pendingApproval }: ApprovalPanelProps) {
  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-zinc-700/80 bg-[linear-gradient(180deg,#18181b_0%,#151518_55%,#141418_100%)] text-zinc-100 shadow-[0_8px_26px_rgba(0,0,0,0.34)]">
      <div className="border-b border-zinc-800/90 px-4 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
          Approval required
          <span className="ml-2 text-[12px] font-medium normal-case tracking-normal text-zinc-400">
            {buildApprovalCategoryLabel(pendingApproval)}
          </span>
        </p>
      </div>
      <div className="p-4">
        <p className="text-[clamp(1.1rem,1.35vw,1.45rem)] font-semibold leading-tight text-zinc-100">
          {buildApprovalPromptTitle(pendingApproval)}
        </p>
        {pendingApproval.command ? (
          <p className="mt-3 overflow-x-auto rounded-lg border border-zinc-700 bg-black/35 px-3 py-2 font-mono text-[13px] text-zinc-100">
            {pendingApproval.command}
          </p>
        ) : (
          <p className="mt-2 text-sm text-zinc-300">{pendingApproval.reason}</p>
        )}
      </div>
    </div>
  );
}
