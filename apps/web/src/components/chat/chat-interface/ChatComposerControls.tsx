import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  ProductMode,
  RunMode,
} from "@repo/shared-types";
import type { WorkflowApprovalOption } from "@repo/platform-client-sdk";
import type { ProviderId } from "../../../types/provider";
import type { ChatSubmitAttachments } from "../chatImageAttachments";
import type { ReviewCommentDraft } from "../../git/reviewComments";
import { ApprovalDock } from "../approval/ApprovalDock.js";
import { ChatInputBar } from "../ChatInputBar";
import type {
  ContextBudgetSnapshot,
  UsageCostSnapshot,
} from "@repo/platform-client-sdk";

export type ComposerLayout = "docked" | "hero";

export interface ChatErrorNoticeProps {
  message: string;
  remediation: string;
  actionLabel: string;
  technicalDetails?: string;
  onOpen?: () => void;
}

interface ChatComposerControlsProps {
  layout: ComposerLayout;
  error?: ChatErrorNoticeProps | null;
  continuation?: {
    status: "reconnecting" | "stopped";
    error: string | null;
    onRetry: () => void;
  } | null;
  approval: {
    pending: ApprovalRequest | null;
    matchingInChatOption: WorkflowApprovalOption | null;
    decisions: ApprovalDecisionKind[];
    busyDecision: ApprovalDecisionKind | null;
    error: string | null;
    onResolve: (decision: ApprovalDecisionKind) => Promise<void>;
  };
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (attachments?: ChatSubmitAttachments) => Promise<boolean>;
  reviewComments: ReviewCommentDraft[];
  onRemoveReviewComment: (commentId: string) => void;
  reviewCommentError: string | null;
  onStop: () => void;
  canStop: boolean;
  isLoading: boolean;
  sessionId: string;
  runId?: string;
  mode: RunMode;
  onModeChange?: (mode: RunMode) => void;
  hasMessages: boolean;
  onModelSelect?: (providerId: ProviderId, modelId: string) => void;
  repoTree: Array<{ path: string; type: string; sha: string }>;
  isLoadingRepoTree: boolean;
  permissionMode?: ProductMode;
  onPermissionModeChange?: (mode: ProductMode) => void;
  contextBudget?: ContextBudgetSnapshot | null;
  usage?: UsageCostSnapshot | null;
  onCompact?: () => void;
  onContextOpen?: () => void;
}

export function ChatComposerControls(props: ChatComposerControlsProps) {
  return (
    <>
      {props.error ? (
        <div className="mb-4">
          <ChatErrorNotice {...props.error} />
        </div>
      ) : null}
      {props.continuation ? (
        <div
          className="mb-4 flex items-center justify-between gap-3 rounded border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100"
          role="status"
        >
          <span>
            {props.continuation.status === "reconnecting"
              ? "Reconnecting to live updates…"
              : `Live updates stopped${props.continuation.error ? `: ${props.continuation.error}` : "."}`}
          </span>
          {props.continuation.status === "stopped" ? (
            <button
              type="button"
              className="rounded border border-amber-200/40 px-2 py-1 text-xs hover:bg-amber-900/40"
              onClick={props.continuation.onRetry}
            >
              Retry updates
            </button>
          ) : null}
        </div>
      ) : null}
      {props.approval.pending ? (
        <ApprovalDock
          pendingApproval={props.approval.pending}
          matchingInChatOption={props.approval.matchingInChatOption}
          decisions={props.approval.decisions}
          busyDecision={props.approval.busyDecision}
          error={props.approval.error}
          onResolve={props.approval.onResolve}
        />
      ) : (
        <ChatInputBar
          input={props.input}
          onChange={props.onInputChange}
          onSubmit={props.onSubmit}
          reviewComments={props.reviewComments}
          onRemoveReviewComment={props.onRemoveReviewComment}
          reviewCommentError={props.reviewCommentError}
          onStop={props.onStop}
          canStop={props.canStop}
          isLoading={props.isLoading}
          sessionId={props.sessionId}
          runId={props.runId}
          mode={props.mode}
          onModeChange={props.onModeChange}
          hasMessages={props.hasMessages}
          onModelSelect={props.onModelSelect}
          repoTree={props.repoTree}
          isLoadingRepoTree={props.isLoadingRepoTree}
          layout={props.layout}
          contextBudget={props.contextBudget}
          usage={props.usage}
          onCompact={props.onCompact}
          onContextOpen={props.onContextOpen}
          permissionMode={props.permissionMode}
          onPermissionModeChange={props.onPermissionModeChange}
        />
      )}
    </>
  );
}

export function ChatErrorNotice({
  message,
  remediation,
  actionLabel,
  technicalDetails,
  onOpen,
}: ChatErrorNoticeProps) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 text-sm text-zinc-300"
    >
      <p className="min-w-0 flex-1">{message}</p>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="rounded px-2.5 py-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
        >
          {actionLabel}
        </button>
      ) : null}
      <details className="basis-full text-xs text-zinc-500">
        <summary className="w-fit cursor-pointer select-none hover:text-zinc-300">
          Details
        </summary>
        <p className="mt-1 text-zinc-400">{remediation}</p>
        {technicalDetails ? (
          <p className="mt-1 font-mono text-zinc-500">{technicalDetails}</p>
        ) : null}
      </details>
    </div>
  );
}
