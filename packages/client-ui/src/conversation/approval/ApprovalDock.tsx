import type { ApprovalDecisionKind, ApprovalRequest } from "@repo/shared-types";
import type { WorkflowApprovalOption } from "@legioncode/sdk";
import { ApprovalActions } from "./ApprovalActions.js";
import {
  buildApprovalCategoryLabel,
  buildApprovalQuestion,
} from "./approvalLabels.js";

interface ApprovalDockProps {
  pendingApproval: ApprovalRequest;
  matchingInChatOption: WorkflowApprovalOption | null;
  decisions: ApprovalDecisionKind[];
  busyDecision: ApprovalDecisionKind | null;
  error: string | null;
  onResolve: (decision: ApprovalDecisionKind) => Promise<void>;
  onStop: () => void;
  canStop: boolean;
}

export function ApprovalDock({
  pendingApproval,
  matchingInChatOption,
  decisions,
  busyDecision,
  error,
  onResolve,
  onStop,
  canStop,
}: ApprovalDockProps) {
  return (
    <div className="mx-auto mb-3 w-full max-w-4xl">
      <div
        data-testid="lifecycle-approval"
        className="flex max-h-[min(45vh,28rem)] min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-700/80 bg-[#18181b] text-sm text-zinc-100 shadow-[0_18px_48px_rgba(0,0,0,0.45)]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-zinc-400">
          <span className="font-medium text-zinc-200">
            {buildApprovalCategoryLabel(pendingApproval)}
          </span>
          <span>Approval required</span>
        </div>
        <div className="min-h-0 max-h-40 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <div role="alert" className="mb-2">
              <p className="max-h-16 overflow-y-auto break-words text-xs text-red-300">
                {error}
              </p>
            </div>
          ) : null}
          <div>
            <p className="font-medium text-zinc-50">
              {buildApprovalQuestion(pendingApproval)}
            </p>
            <p className="mt-1 break-words text-zinc-400">
              {pendingApproval.title}
            </p>
          </div>
          {matchingInChatOption?.description ? (
            <p className="mt-2 max-h-16 overflow-y-auto break-words text-xs text-zinc-400">
              {matchingInChatOption.description}
            </p>
          ) : null}
          {pendingApproval.command ? (
            <pre className="mt-2 max-h-24 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 font-mono leading-relaxed text-zinc-300">
              <code>{pendingApproval.command}</code>
            </pre>
          ) : null}
        </div>
        <div className="shrink-0 border-t border-zinc-800 px-4 py-2.5">
          <ApprovalActions
            decisions={decisions}
            busyDecision={busyDecision}
            onResolve={onResolve}
            matchingInChatOption={matchingInChatOption}
          />
          <div className="mt-2 flex justify-end border-t border-zinc-800 pt-2">
            <button
              type="button"
              aria-label="Stop generation"
              disabled={!canStop}
              onClick={onStop}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Stop generation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
