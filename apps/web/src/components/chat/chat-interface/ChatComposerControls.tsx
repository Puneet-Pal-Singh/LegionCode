import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  ProductMode,
  RunMode,
} from "@repo/shared-types";
import type { ProviderId } from "../../../types/provider";
import type { ChatSubmitAttachments } from "../chatImageAttachments";
import type { ReviewCommentDraft } from "../../git/reviewComments";
import { PRODUCT_MODES } from "@repo/shared-types";
import { ApprovalDock } from "../approval/ApprovalDock.js";
import { ChatInputBar } from "../ChatInputBar";
import { PermissionModeControl } from "../PermissionModeControl";

export type ComposerLayout = "docked" | "hero";

interface ChatComposerControlsProps {
  layout: ComposerLayout;
  error?: {
    message: string;
    remediation: string;
    actionLabel: string;
    onOpen: () => void;
  } | null;
  approval: {
    pending: ApprovalRequest | null;
    decisions: ApprovalDecisionKind[];
    busyDecision: ApprovalDecisionKind | null;
    error: string | null;
    notice: string | null;
    isResolutionPending: boolean;
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
}

export function ChatComposerControls(props: ChatComposerControlsProps) {
  return (
    <>
      {props.error ? (
        <div className="mb-4">
          <ChatErrorNotice {...props.error} />
        </div>
      ) : null}
      {props.approval.pending ? (
        <ApprovalDock
          pendingApproval={props.approval.pending}
          decisions={props.approval.decisions}
          busyDecision={props.approval.busyDecision}
          error={props.approval.error}
          notice={props.approval.notice}
          isResolutionPending={props.approval.isResolutionPending}
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
        />
      )}
      <div
        className={
          props.layout === "hero"
            ? "mt-2 flex items-center gap-2 pl-2"
            : "mt-1 flex items-center gap-2 pl-6"
        }
      >
        <PermissionModeControl
          value={props.permissionMode ?? PRODUCT_MODES.AUTO_FOR_SAFE}
          onChange={(mode) => props.onPermissionModeChange?.(mode)}
          disabled={props.isLoading || !props.onPermissionModeChange}
          appearance="ghost"
        />
      </div>
    </>
  );
}

function ChatErrorNotice({
  message,
  remediation,
  actionLabel,
  onOpen,
}: NonNullable<ChatComposerControlsProps["error"]>) {
  return (
    <div className="space-y-2 rounded border border-red-500/40 bg-red-950/30 px-4 py-3 text-sm text-red-200">
      <p>{message}</p>
      <p className="text-xs text-red-100/80">{remediation}</p>
      <button
        type="button"
        onClick={onOpen}
        className="rounded border border-red-300/40 px-2 py-1 text-xs transition hover:bg-red-900/40"
      >
        {actionLabel}
      </button>
    </div>
  );
}
