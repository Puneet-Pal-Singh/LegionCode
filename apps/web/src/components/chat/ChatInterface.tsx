import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { ChatMessage } from "./ChatMessage";
import { ChatInputBar } from "./ChatInputBar";
import { ChatBranchSelector } from "./ChatBranchSelector";
import { PermissionModeControl } from "./PermissionModeControl";
import type { Message } from "@ai-sdk/react";
import {
  ApprovalRequestSchema,
  PRODUCT_MODES,
  RUN_EVENT_TYPES,
  type ApprovalDecisionKind,
  type ApprovalRequest,
  type DiffContent,
  type FileStatus,
  type ProductMode,
  type RunEvent,
  type RunMode,
} from "@repo/shared-types";
import { z } from "zod";
import type { ProviderId } from "../../types/provider";
import type { ChatDebugEvent } from "../../types/chat-debug.js";
import { useRunSummary } from "../../hooks/useRunSummary.js";
import { useRunEvents } from "../../hooks/useRunEvents.js";
import { useRunActivityFeed } from "../../hooks/useRunActivityFeed.js";
import { getProviderRecoveryAdvice } from "../../lib/provider-recovery";
import { useAuth } from "../../contexts/AuthContext";
import { useProviderStore } from "../../hooks/useProviderStore.js";
import { dispatchOpenSettingsDialog } from "../../lib/settings-dialog-events.js";
import {
  buildChatMessageMetadata,
  buildConversationTurns,
} from "./messageMetadata";
import { buildActivityFeedViewModel } from "../../services/activity/ActivityFeedViewModel.js";
import { ActivityTurn } from "./activity/ActivityTurn.js";
import { WorkflowTimeline } from "./workflow/WorkflowTimeline.js";
import type { ActivityTurnViewModel } from "../../services/activity/ActivityFeedViewModel.js";
import { getBrainHttpBase, runApprovalPath } from "../../lib/platform-endpoints.js";
import { dispatchRunSummaryRefresh } from "../../lib/run-summary-events.js";
import { useGitReview } from "../git/GitReviewContext";
import {
  buildReviewCommentPrompt,
  validateReviewPromptBudget,
} from "../git/reviewComments";
import { getGitDiff } from "../../lib/git-client.js";

// Flip to true when you want to temporarily inspect the legacy workflow debug UI.
const SHOW_WORKFLOW_DEBUG_PANEL = false;
const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const PRIMARY_APPROVAL_DECISIONS: ApprovalDecisionKind[] = [
  "allow_once",
  "allow_for_run",
  "deny",
];
const PLAN_MODE_RECOVERY_SENTINELS = [
  "I couldn't generate a valid structured plan for this turn",
  "Planning timed out before I could build safe executable tasks",
];
const RunSummaryPendingApprovalSchema = z.object({
  pendingApproval: ApprovalRequestSchema.nullish(),
});
type ComposerLayout = "docked" | "hero";

function ChatErrorNotice({
  message,
  remediation,
  actionLabel,
  onOpenProviders,
}: {
  message: string;
  remediation: string;
  actionLabel: string;
  onOpenProviders: () => void;
}) {
  return (
    <div className="px-4 py-3 rounded border border-red-500/40 bg-red-950/30 text-red-200 text-sm space-y-2">
      <p>{message}</p>
      <p className="text-red-100/80 text-xs">{remediation}</p>
      <button
        type="button"
        onClick={onOpenProviders}
        className="text-xs px-2 py-1 rounded border border-red-300/40 hover:bg-red-900/40 transition"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function ApprovalPanel({
  pendingApproval,
  displayedApprovalDecisions,
  approvalBusyDecision,
  approvalError,
  resolveApprovalDecision,
  approvalDecisionButtonClassName,
  formatApprovalDecisionLabel,
  buildApprovalPromptTitle,
}: {
  pendingApproval: ApprovalRequest;
  displayedApprovalDecisions: ApprovalDecisionKind[];
  approvalBusyDecision: ApprovalDecisionKind | null;
  approvalError: string | null;
  resolveApprovalDecision: (decision: ApprovalDecisionKind) => Promise<void>;
  approvalDecisionButtonClassName: (decision: ApprovalDecisionKind) => string;
  formatApprovalDecisionLabel: (decision: ApprovalDecisionKind) => string;
  buildApprovalPromptTitle: (pendingApproval: ApprovalRequest) => string;
}) {
  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-zinc-700/80 bg-[linear-gradient(180deg,#18181b_0%,#151518_55%,#141418_100%)] text-zinc-100 shadow-[0_8px_26px_rgba(0,0,0,0.34)]">
      <div className="border-b border-zinc-800/90 px-4 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
          Pending approval
          <span className="ml-2 text-[12px] font-medium normal-case tracking-normal text-zinc-400">
            Command approval requested
          </span>
        </p>
      </div>
      <div className="p-4">
        <p className="text-[clamp(1.1rem,1.35vw,1.45rem)] font-semibold leading-tight text-zinc-100">
          {buildApprovalPromptTitle(pendingApproval)}
        </p>
        {pendingApproval.command ? (
          <p className="mt-3 rounded-lg border border-zinc-700 bg-black/35 px-3 py-2 font-mono text-[13px] text-zinc-100">
            {pendingApproval.command}
          </p>
        ) : (
          <p className="mt-2 text-sm text-zinc-300">{pendingApproval.reason}</p>
        )}
      </div>
      <div className="border-t border-zinc-800/90 px-4 pb-4 pt-3">
        <div className="flex flex-wrap gap-2">
          {displayedApprovalDecisions.map((decision) => (
            <button
              key={decision}
              type="button"
              disabled={approvalBusyDecision !== null}
              onClick={() => void resolveApprovalDecision(decision)}
              className={approvalDecisionButtonClassName(decision)}
            >
              {formatApprovalDecisionLabel(decision)}
            </button>
          ))}
        </div>
        {approvalError ? (
          <p className="mt-3 text-xs text-red-300">{approvalError}</p>
        ) : null}
      </div>
    </div>
  );
}

function ComposerSecondaryControls({
  layout,
  permissionMode,
  onPermissionModeChange,
  isLoading,
}: {
  layout: ComposerLayout;
  permissionMode?: ProductMode;
  onPermissionModeChange?: (mode: ProductMode) => void;
  isLoading: boolean;
}) {
  return (
    <div
      className={
        layout === "hero"
          ? "mt-2 flex items-center gap-2 pl-2"
          : "mt-1 flex items-center gap-2 pl-6"
      }
    >
      <ChatBranchSelector />
      <PermissionModeControl
        value={permissionMode ?? PRODUCT_MODES.AUTO_FOR_SAFE}
        onChange={(nextMode) => onPermissionModeChange?.(nextMode)}
        disabled={isLoading || !onPermissionModeChange}
        appearance="ghost"
      />
    </div>
  );
}

interface ChatInterfaceProps {
  chatProps: {
    messages: Message[];
    runId: string;
    input: string;
    handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    handleSubmit: () => void;
    append: (message: { role: "user"; content: string }) => Promise<void>;
    stop: () => void;
    canStop?: boolean;
    isLoading: boolean;
    error?: string | null;
    debugEvents?: ChatDebugEvent[];
  };
  sessionId: string;
  mode?: RunMode;
  onModeChange?: (mode: RunMode) => void;
  permissionMode?: ProductMode;
  onPermissionModeChange?: (mode: ProductMode) => void;
  onPendingApprovalChange?: (hasPendingApproval: boolean) => void;
  onArtifactOpen?: (path: string, content: string) => void;
  onReviewOpen?: () => void;
  onModelSelect?: (providerId: ProviderId, modelId: string) => void;
  repoTree?: Array<{ path: string; type: string; sha: string }>;
  isLoadingRepoTree?: boolean;
}

export function ChatInterface({
  chatProps,
  sessionId,
  mode = "build",
  onModeChange,
  permissionMode,
  onPermissionModeChange,
  onPendingApprovalChange,
  onArtifactOpen,
  onReviewOpen,
  onModelSelect,
  repoTree = [],
  isLoadingRepoTree = false,
}: ChatInterfaceProps) {
  const {
    messages,
    runId,
    input,
    handleInputChange,
    handleSubmit,
    append,
    stop,
    canStop,
    isLoading,
    error,
    debugEvents = [],
  } = chatProps;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pendingPlanPrompt, setPendingPlanPrompt] = useState<string | null>(
    null,
  );
  const [expandedActivityTurns, setExpandedActivityTurns] = useState<
    Record<string, boolean>
  >({});
  const [expandedActivityRows, setExpandedActivityRows] = useState<
    Record<string, boolean>
  >({});

  const { summary } = useRunSummary(runId, isLoading);
  const {
    status: gitStatus,
    selectedReviewComments,
    toggleReviewCommentSelected,
    markReviewCommentsDispatching,
    markReviewCommentsDispatched,
    markReviewCommentsDispatchFailed,
  } = useGitReview();
  const { events } = useRunEvents(runId, isLoading);
  const { feed } = useRunActivityFeed(runId);
  const showDebugPanel =
    import.meta.env.VITE_ENABLE_CHAT_DEBUG_PANEL === "true";
  const [approvalBusyDecision, setApprovalBusyDecision] =
    useState<ApprovalDecisionKind | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [dismissedApprovalRequestId, setDismissedApprovalRequestId] = useState<
    string | null
  >(null);
  const [activityNowMs, setActivityNowMs] = useState(() => Date.now());
  const lastAutoSwitchedPlanFailureKeyRef = useRef<string | null>(null);
  const lastReviewDispatchIdsRef = useRef<string[]>([]);
  const pendingChangedFilesRef = useRef<FileStatus[]>([]);
  const previousIsLoadingRef = useRef(isLoading);
  const diffSnapshotByPathRef = useRef<Record<string, DiffContent>>({});
  const { providerModels } = useProviderStore(runId);
  const { login, refreshSession } = useAuth();
  const [reviewCommentError, setReviewCommentError] = useState<string | null>(
    null,
  );
  const [changedFilesByAssistantMessageId, setChangedFilesByAssistantMessageId] =
    useState<Record<string, FileStatus[]>>({});

  const messageMetadataById = useMemo(() => {
    return buildChatMessageMetadata(
      messages,
      debugEvents,
      (modelId) => resolveModelLabel(modelId, providerModels),
      mode === "plan" ? "Plan" : "Build",
    );
  }, [messages, debugEvents, mode, providerModels]);
  const pendingApprovalFromEvents = useMemo(
    () => derivePendingApprovalFromEvents(events),
    [events],
  );
  const activityViewModel = useMemo(
    () => buildActivityFeedViewModel(feed, activityNowMs),
    [feed, activityNowMs],
  );
  const conversationTurns = useMemo(
    () => buildConversationTurns(messages),
    [messages],
  );
  const latestAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant") {
        return message.id;
      }
    }
    return null;
  }, [messages]);
  const loadChangedFileDiff = useCallback(
    async (file: FileStatus): Promise<DiffContent> => {
      const cachedDiff = diffSnapshotByPathRef.current[file.path];
      if (cachedDiff) {
        return cachedDiff;
      }

      const diff = await getGitDiff({
        runId,
        sessionId,
        path: file.path,
        staged: file.isStaged,
      });
      diffSnapshotByPathRef.current[file.path] = diff;
      return diff;
    },
    [runId, sessionId],
  );

  useEffect(() => {
    pendingChangedFilesRef.current = [];
    diffSnapshotByPathRef.current = {};
    previousIsLoadingRef.current = false;
    setChangedFilesByAssistantMessageId({});
  }, [runId]);

  useEffect(() => {
    if (!previousIsLoadingRef.current && isLoading) {
      pendingChangedFilesRef.current = [];
      diffSnapshotByPathRef.current = {};
    }
    previousIsLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    const files = gitStatus?.files ?? [];
    if (files.length === 0) {
      return;
    }
    pendingChangedFilesRef.current = cloneFileStatuses(files);
  }, [gitStatus?.files]);

  useEffect(() => {
    if (isLoading || !latestAssistantMessageId) {
      return;
    }

    const changedFiles = pendingChangedFilesRef.current;
    if (changedFiles.length === 0) {
      return;
    }

    setChangedFilesByAssistantMessageId((current) => {
      if (current[latestAssistantMessageId]?.length) {
        return current;
      }
      return {
        ...current,
        [latestAssistantMessageId]: cloneFileStatuses(changedFiles),
      };
    });
  }, [isLoading, latestAssistantMessageId]);

  useEffect(() => {
    setExpandedActivityTurns({});
    setExpandedActivityRows({});
  }, [runId]);

  useEffect(() => {
    if (feed?.status !== "RUNNING") {
      return;
    }

    const timerId = window.setInterval(() => {
      setActivityNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [feed?.status]);

  const handleInputChangeWrapper = useCallback(
    (value: string) => {
      if (reviewCommentError) {
        setReviewCommentError(null);
      }
      // Create a synthetic event to match the expected interface
      const syntheticEvent = {
        target: { value },
      } as React.ChangeEvent<HTMLTextAreaElement>;
      handleInputChange(syntheticEvent);
    },
    [handleInputChange, reviewCommentError],
  );

  const handleRemoveReviewComment = useCallback(
    (commentId: string) => {
      toggleReviewCommentSelected(commentId, false);
      if (reviewCommentError) {
        setReviewCommentError(null);
      }
    },
    [reviewCommentError, toggleReviewCommentSelected],
  );

  const handleSubmitWithReviewComments = useCallback(async () => {
    const budgetResult = validateReviewPromptBudget(selectedReviewComments, input);
    if (!budgetResult.ok) {
      setReviewCommentError(budgetResult.reason);
      return;
    }

    const { prompt } = buildReviewCommentPrompt(selectedReviewComments, input);
    const selectedIds = selectedReviewComments.map((comment) => comment.id);
    lastReviewDispatchIdsRef.current = selectedIds;
    setReviewCommentError(null);
    markReviewCommentsDispatching(selectedIds);

    try {
      await append({ role: "user", content: prompt });
      markReviewCommentsDispatched(selectedIds);
      handleInputChangeWrapper("");
    } catch (submitError) {
      markReviewCommentsDispatchFailed(selectedIds, { reselect: true });
      lastReviewDispatchIdsRef.current = [];
      const message =
        submitError instanceof Error
          ? submitError.message
          : "Failed to send review comments.";
      setReviewCommentError(message);
    }
  }, [
    append,
    handleInputChangeWrapper,
    input,
    markReviewCommentsDispatchFailed,
    markReviewCommentsDispatched,
    markReviewCommentsDispatching,
    selectedReviewComments,
  ]);

  useEffect(() => {
    if (!pendingPlanPrompt || mode !== "build" || isLoading) {
      return;
    }

    const submitPlanHandoff = async (): Promise<void> => {
      try {
        await append({ role: "user", content: pendingPlanPrompt });
      } catch (submitError) {
        console.warn(
          "[chat/interface] Failed to submit plan handoff",
          submitError,
        );
        handleInputChangeWrapper(pendingPlanPrompt);
      } finally {
        setPendingPlanPrompt(null);
      }
    };

    void submitPlanHandoff();
  }, [append, handleInputChangeWrapper, isLoading, mode, pendingPlanPrompt]);

  useEffect(() => {
    if (!error || lastReviewDispatchIdsRef.current.length === 0) {
      return;
    }

    markReviewCommentsDispatchFailed(lastReviewDispatchIdsRef.current, {
      reselect: false,
    });
    lastReviewDispatchIdsRef.current = [];
  }, [error, markReviewCommentsDispatchFailed]);

  useEffect(() => {
    if (isLoading || error || lastReviewDispatchIdsRef.current.length === 0) {
      return;
    }

    lastReviewDispatchIdsRef.current = [];
  }, [error, isLoading]);

  useEffect(() => {
    if (mode !== "plan" || !onModeChange) {
      return;
    }

    const latestAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!latestAssistantMessage || !latestAssistantMessage.content) {
      return;
    }
    const latestAssistantMessageKey = `${runId}:${latestAssistantMessage.id}`;
    if (lastAutoSwitchedPlanFailureKeyRef.current === latestAssistantMessageKey) {
      return;
    }

    const isRecoverablePlannerFailure = PLAN_MODE_RECOVERY_SENTINELS.some(
      (sentinel) => latestAssistantMessage.content.includes(sentinel),
    );
    if (!isRecoverablePlannerFailure) {
      return;
    }

    lastAutoSwitchedPlanFailureKeyRef.current = latestAssistantMessageKey;
    console.warn(
      `[chat/interface] Auto-switching runId=${runId} from plan to build after planner recovery output.`,
    );
    onModeChange("build");
  }, [messages, mode, onModeChange, runId]);

  const handleUsePlanInBuild = () => {
    const handoffPrompt = summary?.planArtifact?.handoff?.prompt?.trim();
    if (!handoffPrompt) {
      return;
    }

    setPendingPlanPrompt(handoffPrompt);
    if (mode !== "build") {
      onModeChange?.("build");
    }
  };

  const resolveApprovalDecision = useCallback(
    async (decision: ApprovalDecisionKind) => {
      const pending = summary?.pendingApproval ?? pendingApprovalFromEvents;
      if (
        !pending ||
        pending.requestId === dismissedApprovalRequestId
      ) {
        return;
      }
      setApprovalBusyDecision(decision);
      setApprovalError(null);
      try {
        const response = await submitApprovalDecision({
          runId,
          requestId: pending.requestId,
          decision,
        });
        if (!response.ok) {
          const message = await readApprovalErrorMessage(response);
          const isStaleApproval =
            response.status === 409 || isNoPendingApprovalError(message);
          if (isStaleApproval) {
            const latestPending = await fetchLatestPendingApproval(runId);
            if (
              latestPending &&
              latestPending.requestId !== pending.requestId &&
              latestPending.availableDecisions.includes(decision)
            ) {
              const retryResponse = await submitApprovalDecision({
                runId,
                requestId: latestPending.requestId,
                decision,
              });
              if (!retryResponse.ok) {
                const retryMessage = await readApprovalErrorMessage(retryResponse);
                const isRetryStaleApproval =
                  retryResponse.status === 409 ||
                  isNoPendingApprovalError(retryMessage);
                if (isRetryStaleApproval) {
                  setDismissedApprovalRequestId(latestPending.requestId);
                  dispatchRunSummaryRefresh(runId);
                  return;
                }
                throw new Error(
                  retryMessage ||
                    `Failed to resolve approval (${retryResponse.status})`,
                );
              }
              setDismissedApprovalRequestId(latestPending.requestId);
              dispatchRunSummaryRefresh(runId);
              return;
            }

            setDismissedApprovalRequestId(pending.requestId);
            dispatchRunSummaryRefresh(runId);
            return;
          }
          throw new Error(
            message || `Failed to resolve approval (${response.status})`,
          );
        }
        setDismissedApprovalRequestId(pending.requestId);
        dispatchRunSummaryRefresh(runId);
      } catch (error) {
        setApprovalError(
          error instanceof Error
            ? error.message
            : "Failed to resolve approval request.",
        );
      } finally {
        setApprovalBusyDecision(null);
      }
    },
    [
      dismissedApprovalRequestId,
      pendingApprovalFromEvents,
      runId,
      summary?.pendingApproval,
    ],
  );

  const recoveryAdvice = getProviderRecoveryAdvice(error);
  const openProviderRecoverySurface = useCallback(() => {
    if (recoveryAdvice.recoveryTarget === "auth") {
      login();
      return;
    }
    dispatchOpenSettingsDialog(recoveryAdvice.recoveryTarget);
  }, [login, recoveryAdvice.recoveryTarget]);

  useEffect(() => {
    if (recoveryAdvice.recoveryTarget !== "auth") {
      return;
    }
    void refreshSession();
  }, [recoveryAdvice.recoveryTarget, refreshSession]);
  const activeInlineTurn = activityViewModel.turns.find(
    (turn) => turn.hasVisibleRows && !turn.defaultCollapsed,
  );
  const planHandoffAction =
    summary?.planArtifact?.handoff && (mode === "build" || onModeChange)
      ? handleUsePlanInBuild
      : undefined;
  const pendingApprovalCandidate = useMemo(() => {
    if (!summary) {
      return pendingApprovalFromEvents;
    }

    if ("pendingApproval" in summary) {
      if (summary.pendingApproval) {
        return summary.pendingApproval;
      }
      const isTerminal = Boolean(
        summary.status && TERMINAL_RUN_STATUSES.has(summary.status),
      );
      return isTerminal ? null : pendingApprovalFromEvents;
    }

    return pendingApprovalFromEvents;
  }, [pendingApprovalFromEvents, summary]);
  const pendingApproval = useMemo(() => {
    if (!pendingApprovalCandidate) {
      return null;
    }
    if (pendingApprovalCandidate.requestId === dismissedApprovalRequestId) {
      return null;
    }
    return pendingApprovalCandidate;
  }, [dismissedApprovalRequestId, pendingApprovalCandidate]);

  useEffect(() => {
    if (!pendingApprovalCandidate) {
      if (dismissedApprovalRequestId !== null) {
        setDismissedApprovalRequestId(null);
      }
      return;
    }
    if (
      dismissedApprovalRequestId &&
      pendingApprovalCandidate.requestId !== dismissedApprovalRequestId
    ) {
      setDismissedApprovalRequestId(null);
      setApprovalError(null);
    }
  }, [dismissedApprovalRequestId, pendingApprovalCandidate]);

  useEffect(() => {
    onPendingApprovalChange?.(Boolean(pendingApproval));
  }, [onPendingApprovalChange, pendingApproval]);
  const displayedApprovalDecisions = useMemo(() => {
    if (!pendingApproval) {
      return [];
    }
    const preferredDecisions = PRIMARY_APPROVAL_DECISIONS.filter((decision) =>
      pendingApproval.availableDecisions.includes(decision),
    );
    const remainingDecisions = pendingApproval.availableDecisions.filter(
      (decision) => !preferredDecisions.includes(decision),
    );
    return [...preferredDecisions, ...remainingDecisions];
  }, [pendingApproval]);
  const chatEntries = useMemo(
    () => buildChatEntries(conversationTurns, activityViewModel.turns),
    [activityViewModel.turns, conversationTurns],
  );
  const hasUserMessage = useMemo(
    () =>
      messages.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.trim().length > 0,
      ),
    [messages],
  );
  const showHeroComposer =
    !hasUserMessage && !isLoading && !pendingApproval;
  const activityScrollSignal = useMemo(
    () =>
      activityViewModel.turns
        .map(
          (turn) =>
            `${turn.key}:${turn.rows.length}:${turn.summaryLabel}:${turn.isActiveTurn ? "active" : "idle"}`,
        )
        .join("|"),
    [activityViewModel.turns],
  );
  const renderActivityTurn = (turn: ActivityTurnViewModel) => (
    <ActivityTurn
      key={turn.key}
      turn={turn}
      expanded={expandedActivityTurns[turn.key] ?? !turn.defaultCollapsed}
      onToggleTurn={() =>
        setExpandedActivityTurns((current) => ({
          ...current,
          [turn.key]: !(current[turn.key] ?? !turn.defaultCollapsed),
        }))
      }
      expandedRows={expandedActivityRows}
      onToggleRow={(rowKey, expanded) =>
        setExpandedActivityRows((current) => ({
          ...current,
          [rowKey]: !expanded,
        }))
      }
      onUsePlanInBuild={planHandoffAction}
    />
  );
  const renderComposerControls = (layout: ComposerLayout) => (
    <>
      {error ? (
        <div className="mb-4">
          <ChatErrorNotice
            message={recoveryAdvice.message}
            remediation={recoveryAdvice.remediation}
            actionLabel={recoveryAdvice.actionLabel}
            onOpenProviders={openProviderRecoverySurface}
          />
        </div>
      ) : null}
      {pendingApproval ? (
        <ApprovalPanel
          pendingApproval={pendingApproval}
          displayedApprovalDecisions={displayedApprovalDecisions}
          approvalBusyDecision={approvalBusyDecision}
          approvalError={approvalError}
          resolveApprovalDecision={resolveApprovalDecision}
          approvalDecisionButtonClassName={approvalDecisionButtonClassName}
          formatApprovalDecisionLabel={formatApprovalDecisionLabel}
          buildApprovalPromptTitle={buildApprovalPromptTitle}
        />
      ) : (
        <ChatInputBar
          input={input}
          onChange={handleInputChangeWrapper}
          onSubmit={
            selectedReviewComments.length > 0
              ? () => void handleSubmitWithReviewComments()
              : handleSubmit
          }
          reviewComments={selectedReviewComments}
          onRemoveReviewComment={handleRemoveReviewComment}
          reviewCommentError={reviewCommentError}
          onStop={stop}
          canStop={canStop ?? isLoading}
          isLoading={isLoading}
          sessionId={sessionId}
          mode={mode}
          onModeChange={onModeChange}
          hasMessages={messages.length > 0}
          onModelSelect={onModelSelect}
          repoTree={repoTree}
          isLoadingRepoTree={isLoadingRepoTree}
          layout={layout}
        />
      )}
      <ComposerSecondaryControls
        layout={layout}
        permissionMode={permissionMode}
        onPermissionModeChange={onPermissionModeChange}
        isLoading={isLoading}
      />
    </>
  );

  // Auto-scroll to bottom on new messages and live activity updates.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [activityScrollSignal, isLoading, messages]);

  return (
    <div className="flex flex-col h-full bg-black">
      {/* Scrollable Messages Container - Centered with max-width */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        {showHeroComposer ? (
          <div className="mx-auto flex min-h-full w-full max-w-4xl items-center justify-center py-8">
            <div className="w-full">
              <h1 className="mb-8 text-center text-5xl font-semibold tracking-tight text-zinc-100">
                What should we build?
              </h1>
              {renderComposerControls("hero")}
            </div>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto space-y-6">
            {showDebugPanel && (
              <div className="rounded border border-cyan-800/60 bg-cyan-950/20">
                <div className="px-3 py-2 border-b border-cyan-800/40 text-cyan-200 text-xs font-semibold uppercase tracking-wider">
                  Debug Trace (Client)
                </div>
                <div className="max-h-56 overflow-y-auto p-3 space-y-3">
                  {debugEvents.length === 0 ? (
                    <div className="text-xs text-cyan-300/70">
                      Waiting for first request...
                    </div>
                  ) : (
                    debugEvents.map((event) => (
                      <div
                        key={event.id}
                        className="rounded border border-cyan-900/60 bg-black/50 p-2"
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
                            {event.phase}
                          </span>
                          <span className="text-[11px] text-zinc-400">
                            {new Date(event.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="text-xs text-cyan-100 mb-2">
                          {event.summary}
                        </div>
                        <pre className="text-[11px] text-zinc-200 whitespace-pre-wrap break-all overflow-x-auto">
                          {formatDebugPayload(event.payload)}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {chatEntries.map((entry) =>
              entry.kind === "message" ? (
                <ChatMessage
                  key={entry.message.id}
                  message={entry.message}
                  metadata={messageMetadataById[entry.message.id]}
                  onArtifactOpen={onArtifactOpen}
                  onReviewOpen={onReviewOpen}
                  changedFilesSummary={resolveChangedFilesSummary({
                    messageId: entry.message.id,
                    latestAssistantMessageId,
                    isLoading,
                    liveFiles: gitStatus?.files,
                    snapshots: changedFilesByAssistantMessageId,
                    loadFileDiff: loadChangedFileDiff,
                  })}
                />
              ) : (
                renderActivityTurn(entry.turn)
              ),
            )}

            {/* Loading indicator */}
            {isLoading && !activeInlineTurn && (
              <div className="py-2 text-sm font-medium text-zinc-500">
                <span className="bg-[linear-gradient(90deg,rgba(113,113,122,0.9)_0%,rgba(228,228,231,0.95)_45%,rgba(113,113,122,0.9)_100%)] bg-[length:220%_100%] bg-clip-text text-transparent animate-shimmer">
                  Thinking
                </span>
              </div>
            )}

            {SHOW_WORKFLOW_DEBUG_PANEL ? (
              <details className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3">
                <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">
                  Workflow Debug
                </summary>
                <div className="mt-4">
                  <WorkflowTimeline
                    events={events}
                    summary={summary}
                    isLoading={isLoading}
                    onJumpToLatest={() => {
                      scrollRef.current?.scrollTo({
                        top: scrollRef.current.scrollHeight,
                        behavior: "smooth",
                      });
                    }}
                  />
                </div>
              </details>
            ) : null}
          </div>
        )}
      </div>

      {/* Input Area - Centered */}
      {showHeroComposer ? null : (
        <div className="px-6 pb-4">
        <div className="max-w-4xl mx-auto">
          {renderComposerControls("docked")}
        </div>
      </div>
      )}
    </div>
  );
}

async function submitApprovalDecision(input: {
  runId: string;
  requestId: string;
  decision: ApprovalDecisionKind;
}): Promise<Response> {
  return fetch(runApprovalPath(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      runId: input.runId,
      requestId: input.requestId,
      decision: input.decision,
    }),
  });
}

function resolveChangedFilesSummary(input: {
  messageId: string;
  latestAssistantMessageId: string | null;
  isLoading: boolean;
  liveFiles: FileStatus[] | undefined;
  snapshots: Record<string, FileStatus[]>;
  loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
}):
  | {
      files: FileStatus[];
      loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
    }
  | undefined {
  const liveFiles =
    !input.isLoading &&
    input.messageId === input.latestAssistantMessageId &&
    input.liveFiles?.length
      ? input.liveFiles
      : undefined;
  const files = liveFiles ?? input.snapshots[input.messageId];
  if (!files?.length) {
    return undefined;
  }

  return {
    files,
    loadFileDiff: input.loadFileDiff,
  };
}

function cloneFileStatuses(files: FileStatus[]): FileStatus[] {
  return files.map((file) => ({ ...file }));
}

async function fetchLatestPendingApproval(
  runId: string,
): Promise<ApprovalRequest | null> {
  const response = await fetch(
    `${getBrainHttpBase()}/api/run/summary?runId=${encodeURIComponent(runId)}`,
    {
      credentials: "include",
    },
  );
  if (!response.ok) {
    return null;
  }

  const payload = RunSummaryPendingApprovalSchema.safeParse(await response.json());
  if (!payload.success) {
    console.warn(
      `[chat/interface] Invalid run summary payload while refreshing approval for runId=${runId}`,
      payload.error,
    );
    return null;
  }

  return payload.data.pendingApproval ?? null;
}

function formatDebugPayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload, null, 2);
    if (!serialized) {
      return "(empty payload)";
    }
    if (serialized.length > 5000) {
      return `${serialized.slice(0, 5000)}\n...<truncated>`;
    }
    return serialized;
  } catch {
    return String(payload);
  }
}

function formatApprovalDecisionLabel(decision: ApprovalDecisionKind): string {
  switch (decision) {
    case "allow_once":
      return "Allow once";
    case "allow_for_run":
      return "Allow for this session";
    case "allow_persistent_rule":
      return "Allow in future";
    case "deny":
      return "Deny";
    case "abort":
      return "Abort";
    default:
      return decision;
  }
}

function approvalDecisionButtonClassName(
  decision: ApprovalDecisionKind,
): string {
  const baseClassName =
    "rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

  switch (decision) {
    case "allow_once":
      return `${baseClassName} border-blue-500/35 bg-blue-500/10 text-blue-100 hover:border-blue-400/50 hover:bg-blue-500/15`;
    case "allow_for_run":
      return `${baseClassName} border-emerald-500/35 bg-emerald-500/10 text-emerald-100 hover:border-emerald-400/50 hover:bg-emerald-500/15`;
    case "deny":
    case "abort":
      return `${baseClassName} border-red-500/35 bg-red-500/10 text-red-100 hover:border-red-400/50 hover:bg-red-500/15`;
    case "allow_persistent_rule":
    default:
      return `${baseClassName} border-zinc-600 bg-zinc-900/80 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800/80`;
  }
}

function buildApprovalPromptTitle(pendingApproval: ApprovalRequest): string {
  const title = pendingApproval.title.trim();
  if (title.endsWith("?")) {
    return title;
  }

  const wantsToMatch = title.match(/^(?:legioncode)\s+wants\s+to\s+(.+)$/i);
  if (wantsToMatch?.[1]) {
    return `Do you want me to ${wantsToMatch[1]}?`;
  }

  switch (pendingApproval.category) {
    case "git_mutation":
      return "Do you want me to run this git command?";
    case "filesystem_write":
      return "Do you want me to write files in this workspace?";
    case "network_external":
      return "Do you want me to access an external network target?";
    case "outside_workspace":
      return "Do you want me to run this command outside the workspace?";
    case "subagent_spawn":
      return "Do you want me to start a sub-agent?";
    case "provider_connect":
      return "Do you want me to connect this provider?";
    case "deploy_or_infra_mutation":
      return "Do you want me to run this deployment action?";
    case "dangerous_retry":
      return "Do you want me to retry this risky action?";
    case "shell_command":
    default:
      return "Do you want me to run this command?";
  }
}

async function readApprovalErrorMessage(response: Response): Promise<string> {
  const raw = await response.text();
  if (!raw.trim()) {
    return `Failed to resolve approval (${response.status})`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Non-JSON responses fall back to raw text.
  }

  return raw.trim();
}

function isNoPendingApprovalError(message: string): boolean {
  return message.toLowerCase().includes("no pending approval request found");
}

function derivePendingApprovalFromEvents(
  events: RunEvent[],
): ApprovalRequest | null {
  if (events.length === 0) {
    return null;
  }

  const pendingByRequestId = new Map<string, ApprovalRequest>();
  for (const event of events) {
    if (event.type === RUN_EVENT_TYPES.APPROVAL_REQUESTED) {
      pendingByRequestId.set(event.payload.request.requestId, event.payload.request);
      continue;
    }
    if (event.type === RUN_EVENT_TYPES.APPROVAL_RESOLVED) {
      pendingByRequestId.delete(event.payload.requestId);
    }
  }

  const pendingRequests = [...pendingByRequestId.values()];
  if (pendingRequests.length === 0) {
    return null;
  }

  pendingRequests.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  return pendingRequests[pendingRequests.length - 1] ?? null;
}

type ChatInterfaceEntry =
  | { kind: "message"; message: Message }
  | { kind: "turn"; turn: ActivityTurnViewModel };

function buildChatEntries(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
  turns: ActivityTurnViewModel[],
): ChatInterfaceEntry[] {
  const entries: ChatInterfaceEntry[] = [];
  const activityTurnsByMessageId = correlateActivityTurnsToMessages(
    conversationTurns,
    turns,
  );

  for (const conversationTurn of conversationTurns) {
    if (conversationTurn.userMessage) {
      entries.push({
        kind: "message",
        message: conversationTurn.userMessage,
      });

      const matchedActivityTurns =
        activityTurnsByMessageId.get(conversationTurn.userMessage.id) ?? [];
      for (const activityTurn of matchedActivityTurns) {
        if (activityTurn.hasVisibleRows) {
          entries.push({ kind: "turn", turn: activityTurn });
        }
      }
    }

    if (conversationTurn.assistantMessage) {
      entries.push({
        kind: "message",
        message: conversationTurn.assistantMessage,
      });
    }
  }

  return entries;
}

function correlateActivityTurnsToMessages(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
  turns: ActivityTurnViewModel[],
): Map<string, ActivityTurnViewModel[]> {
  const assignments = new Map<string, ActivityTurnViewModel[]>();
  const conversationUserTurns = conversationTurns.filter(
    (
      turn,
    ): turn is ReturnType<typeof buildConversationTurns>[number] & {
      userMessage: Message;
    } => Boolean(turn.userMessage),
  );
  const availableConversationTurnIndexes = new Set(
    conversationUserTurns.map((_, index) => index),
  );

  for (let activityIndex = turns.length - 1; activityIndex >= 0; activityIndex -= 1) {
    const activityTurn = turns[activityIndex];
    if (!activityTurn?.hasVisibleRows) {
      continue;
    }

    const matchedIndex =
      findMatchingConversationTurnIndex(
        conversationUserTurns,
        availableConversationTurnIndexes,
        activityTurn.userPrompt,
      ) ??
      findLatestAvailableConversationTurnIndex(availableConversationTurnIndexes);
    if (matchedIndex === null) {
      console.warn(
        "[chat/transcript] Activity turn could not be correlated to a user message.",
        { activityTurnKey: activityTurn.key },
      );
      continue;
    }

    const matchedConversationTurn = conversationUserTurns[matchedIndex];
    if (!matchedConversationTurn) {
      console.warn(
        "[chat/transcript] Activity turn matched an unavailable user message index.",
        { activityTurnKey: activityTurn.key, matchedIndex },
      );
      availableConversationTurnIndexes.delete(matchedIndex);
      continue;
    }

    availableConversationTurnIndexes.delete(matchedIndex);
    const existingAssignments =
      assignments.get(matchedConversationTurn.userMessage.id) ?? [];
    existingAssignments.unshift(activityTurn);
    assignments.set(matchedConversationTurn.userMessage.id, existingAssignments);
  }

  return assignments;
}

function findMatchingConversationTurnIndex(
  conversationTurns: Array<
    ReturnType<typeof buildConversationTurns>[number] & { userMessage: Message }
  >,
  availableConversationTurnIndexes: Set<number>,
  userPrompt: string | null,
): number | null {
  const normalizedUserPrompt = normalizePromptForMatching(userPrompt);
  if (!normalizedUserPrompt) {
    return null;
  }

  for (let index = conversationTurns.length - 1; index >= 0; index -= 1) {
    if (!availableConversationTurnIndexes.has(index)) {
      continue;
    }
    const conversationPrompt = normalizePromptForMatching(
      conversationTurns[index]?.userMessage.content,
    );
    if (conversationPrompt === normalizedUserPrompt) {
      return index;
    }
  }

  return null;
}

function findLatestAvailableConversationTurnIndex(
  availableConversationTurnIndexes: Set<number>,
): number | null {
  const indexes = Array.from(availableConversationTurnIndexes);
  if (indexes.length === 0) {
    return null;
  }

  return Math.max(...indexes);
}

function normalizePromptForMatching(content: string | null | undefined): string {
  if (typeof content !== "string") {
    return "";
  }

  return content.trim();
}

function resolveModelLabel(
  modelId: string,
  providerModels: Record<string, Array<{ id: string; name: string }>>,
): string {
  for (const models of Object.values(providerModels)) {
    const matched = models.find((model) => model.id === modelId);
    if (matched?.name) {
      return matched.name;
    }
  }
  return summarizeModelId(modelId);
}

function summarizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return "Unknown model";
  }
  const withoutProvider = trimmed.includes("/")
    ? (trimmed.split("/").pop() ?? trimmed)
    : trimmed;
  return withoutProvider.replace(/:free$/i, "").replace(/-/g, " ");
}
