import type { ReactNode } from "react";
import {
  ChatErrorNotice,
  type ChatErrorNoticeProps,
  type ComposerDelivery,
} from "@legioncode/client-ui";
import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  ProductMode,
  RunMode,
} from "@repo/shared-types";
import type { WorkflowApprovalOption } from "@legioncode/sdk";
import type { ProviderId } from "../../../types/provider";
import type { ChatSubmitAttachments } from "@legioncode/client-ui";
import type { ReviewCommentDraft } from "@legioncode/client-ui";
import { ApprovalDock } from "@legioncode/client-ui";
import { WebChatInputBar as ChatInputBar } from "../WebChatInputBar";
import type { ContextBudgetSnapshot, UsageCostSnapshot } from "@legioncode/sdk";

export type ComposerLayout = "docked" | "hero";

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
  onSubmit: (
    attachments?: ChatSubmitAttachments,
    delivery?: ComposerDelivery,
  ) => Promise<boolean>;
  onFollowUpSubmit?: (
    attachments: ChatSubmitAttachments | undefined,
    delivery: ComposerDelivery,
  ) => Promise<boolean>;
  canResume?: boolean;
  onResume?: () => Promise<boolean>;
  resumeUnavailableMessage?: string | null;
  queuePanel?: ReactNode;
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
  const hasAuxiliaryContent = Boolean(
    props.error ||
    props.continuation ||
    props.resumeUnavailableMessage ||
    props.queuePanel,
  );
  return (
    <div className="flex max-h-[min(50vh,28rem)] min-h-0 flex-col">
      {hasAuxiliaryContent ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {props.error ? (
            <div className="mb-4 max-h-28 overflow-y-auto">
              <ChatErrorNotice {...props.error} />
            </div>
          ) : null}
          {props.continuation ? (
            <div
              className="mb-4 flex max-h-24 items-center justify-between gap-3 overflow-y-auto rounded border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100"
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
          {props.resumeUnavailableMessage ? (
            <p
              role="alert"
              className="mb-3 text-right text-xs text-amber-200/90"
            >
              {props.resumeUnavailableMessage}
            </p>
          ) : null}
          {props.queuePanel ? (
            <div className="mb-3 min-h-0 overflow-y-auto overscroll-contain">
              {props.queuePanel}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 shrink-0">
        {props.approval.pending ? (
          <ApprovalDock
            pendingApproval={props.approval.pending}
            matchingInChatOption={props.approval.matchingInChatOption}
            decisions={props.approval.decisions}
            busyDecision={props.approval.busyDecision}
            error={props.approval.error}
            onResolve={props.approval.onResolve}
            onStop={props.onStop}
            canStop={props.canStop}
          />
        ) : null}
        <div hidden={Boolean(props.approval.pending)}>
          <ChatInputBar
            isHidden={Boolean(props.approval.pending)}
            input={props.input}
            onChange={props.onInputChange}
            onSubmit={props.onSubmit}
            onFollowUpSubmit={props.onFollowUpSubmit}
            canResume={props.canResume}
            onResume={props.onResume}
            reviewComments={props.reviewComments}
            onRemoveReviewComment={props.onRemoveReviewComment}
            reviewCommentError={props.reviewCommentError}
            onStop={props.approval.pending ? undefined : props.onStop}
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
        </div>
      </div>
    </div>
  );
}
