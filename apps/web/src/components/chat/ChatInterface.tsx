import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { ChatMessage } from "./ChatMessage";
import { ChatInputBar } from "./ChatInputBar";
import type { ChatSubmitAttachments } from "./chatImageAttachments";
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
  type PromptArtifactReviewSource,
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
import {
  buildRunTerminalViewModel,
  type RunTerminalViewModel,
} from "../../services/workflow/RunTerminalViewModel.js";
import {
  buildTranscriptActivityTurns,
  mergeTranscriptAndLiveActivityTurns,
} from "../../services/activity/TranscriptActivityParts.js";
import { ActivityTurn } from "./activity/ActivityTurn.js";
import { WorkflowTimeline } from "./workflow/WorkflowTimeline.js";
import type { ActivityTurnViewModel } from "../../services/activity/ActivityFeedViewModel.js";
import {
  getBrainHttpBase,
  runApprovalPath,
} from "../../lib/platform-endpoints.js";
import { dispatchRunSummaryRefresh } from "../../lib/run-summary-events.js";
import {
  isApprovalRequiredRunStatus,
  isTerminalRunStatus,
  normalizeRunStatus,
} from "../../lib/run-status.js";
import { useGitReview } from "../git/GitReviewContext";
import {
  buildReviewCommentPrompt,
  validateReviewPromptBudget,
} from "../git/reviewComments";
import { getGitDiff } from "../../lib/git-client.js";
import {
  getEditArtifactDiff,
  getEditArtifactReviewSourceByMessage,
} from "../../lib/edit-artifacts-client.js";
import { ApprovalDock } from "./approval/ApprovalDock.js";
import { getDisplayedApprovalDecisions } from "./approval/approvalDecisions.js";

// Flip to true when you want to temporarily inspect the legacy workflow debug UI.
const SHOW_WORKFLOW_DEBUG_PANEL = false;
const PLAN_MODE_RECOVERY_SENTINELS = [
  "I couldn't generate a valid structured plan for this turn",
  "Planning timed out before I could build safe executable tasks",
];
const APPROVAL_NOTICE_CLEAR_DELAY_MS = 5_000;
const RunSummaryPendingApprovalSchema = z.object({
  pendingApproval: ApprovalRequestSchema.nullish(),
});
type ComposerLayout = "docked" | "hero";
type ApprovalNotice =
  | { kind: "resolved"; requestId: string }
  | { kind: "stale"; requestId: string }
  | null;

function getApprovalNoticeText(notice: ApprovalNotice): string | null {
  if (!notice) {
    return null;
  }
  return notice.kind === "resolved"
    ? "Approval recorded. Continuing..."
    : "Approval request is no longer pending.";
}

function ChatLoadingIndicator() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl items-center justify-center py-8">
      <div
        role="status"
        aria-label="Loading conversation"
        className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-800 border-t-zinc-300"
      />
    </div>
  );
}

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
    handleSubmit: (
      event?: React.FormEvent,
      attachments?: ChatSubmitAttachments,
    ) => Promise<boolean>;
    append: (message: { role: "user"; content: string }) => Promise<void>;
    stop: () => void;
    canStop?: boolean;
    isLoading: boolean;
    hasHydrated?: boolean;
    error?: string | null;
    debugEvents?: ChatDebugEvent[];
  };
  sessionId: string;
  hasStartedSession?: boolean;
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
  hasStartedSession = false,
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
    hasHydrated = true,
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
  const isTerminalSummarySettled = Boolean(
    summary?.status &&
      isTerminalRunStatus(summary.status) &&
      !isApprovalRequiredRunStatus(summary.status),
  );
  const normalizedSummaryStatus = normalizeRunStatus(summary?.status);
  const isCanonicalRunActive =
    normalizedSummaryStatus === "RUNNING" ||
    isApprovalRequiredRunStatus(normalizedSummaryStatus) ||
    Boolean(summary?.pendingApproval);
  const activeRunLoading =
    !isTerminalSummarySettled && (isLoading || isCanonicalRunActive);
  const {
    status: gitStatus,
    selectedReviewComments,
    openPromptArtifactReview,
    toggleReviewCommentSelected,
    markReviewCommentsDispatching,
    markReviewCommentsDispatched,
    markReviewCommentsDispatchFailed,
  } = useGitReview();
  const { events } = useRunEvents(runId, activeRunLoading);
  const { feed } = useRunActivityFeed(runId, activeRunLoading);
  const showDebugPanel =
    import.meta.env.VITE_ENABLE_CHAT_DEBUG_PANEL === "true";
  const [approvalBusyDecision, setApprovalBusyDecision] =
    useState<ApprovalDecisionKind | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalNotice, setApprovalNotice] = useState<ApprovalNotice>(null);
  const [dismissedApprovalRequestId, setDismissedApprovalRequestId] = useState<
    string | null
  >(null);
  const [dismissedApprovalCreatedAt, setDismissedApprovalCreatedAt] = useState<
    string | null
  >(null);
  const [activityNowMs, setActivityNowMs] = useState(() => Date.now());
  const lastAutoSwitchedPlanFailureKeyRef = useRef<string | null>(null);
  const lastReviewDispatchIdsRef = useRef<string[]>([]);
  const isSubmittingApprovalDecisionRef = useRef(false);
  const pendingChangedFilesRef = useRef<FileStatus[]>([]);
  const turnBaselineFilesRef = useRef<FileStatus[]>([]);
  const lastSettledFilesRef = useRef<FileStatus[]>([]);
  const previousIsLoadingRef = useRef(isLoading);
  const diffSnapshotsByMessageRef = useRef<Record<string, DiffContent>>({});
  const artifactLookupMissesRef = useRef<Set<string>>(new Set());
  const inflightArtifactLookupsRef = useRef<Set<string>>(new Set());
  const { providerModels } = useProviderStore(runId);
  const { login, refreshSession } = useAuth();
  const [reviewCommentError, setReviewCommentError] = useState<string | null>(
    null,
  );
  const [
    changedFilesByAssistantMessageId,
    setChangedFilesByAssistantMessageId,
  ] = useState<Record<string, FileStatus[]>>({});
  const [
    artifactSourcesByAssistantMessageId,
    setArtifactSourcesByAssistantMessageId,
  ] = useState<Record<string, PromptArtifactReviewSource>>({});
  const previousScrollScopeKeyRef = useRef<string | null>(null);

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
  const scopedFeed = feed?.runId === runId ? feed : null;
  const displayFeed = useMemo(
    () =>
      !activeRunLoading && scopedFeed?.status === "RUNNING"
        ? { ...scopedFeed, status: "CANCELLED" as const }
        : scopedFeed,
    [activeRunLoading, scopedFeed],
  );
  const activityViewModel = useMemo(() => {
    const liveViewModel = buildActivityFeedViewModel(
      displayFeed,
      activityNowMs,
    );
    return {
      ...liveViewModel,
      turns: mergeTranscriptAndLiveActivityTurns(
        buildTranscriptActivityTurns(messages),
        liveViewModel.turns,
      ),
    };
  }, [activityNowMs, displayFeed, messages]);
  const conversationTurns = useMemo(
    () => buildConversationTurns(messages),
    [messages],
  );
  const activityChangedFilesByAssistantMessageId = useMemo(() => {
    if (!scopedFeed) {
      return {};
    }
    return deriveActivityChangedFilesByAssistantMessageId(
      conversationTurns,
      activityViewModel.turns,
    );
  }, [activityViewModel.turns, conversationTurns, scopedFeed]);
  const changedFileSnapshotsByAssistantMessageId = useMemo(
    () =>
      mergeChangedFileSnapshots(
        changedFilesByAssistantMessageId,
        activityChangedFilesByAssistantMessageId,
      ),
    [
      activityChangedFilesByAssistantMessageId,
      changedFilesByAssistantMessageId,
    ],
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
    async (messageId: string, file: FileStatus): Promise<DiffContent> => {
      const cacheKey = buildChangedFileDiffCacheKey(messageId, file);
      const cachedDiff = diffSnapshotsByMessageRef.current[cacheKey];
      if (cachedDiff) {
        return cachedDiff;
      }

      const artifactSource = artifactSourcesByAssistantMessageId[messageId];
      if (artifactSource) {
        const response = await getEditArtifactDiff({
          artifactId: artifactSource.artifactId,
          path: file.path,
        });
        diffSnapshotsByMessageRef.current[cacheKey] = response.diff;
        return response.diff;
      }

      const activityPreviewDiff = buildDiffFromActivityPreview(file);
      if (activityPreviewDiff) {
        diffSnapshotsByMessageRef.current[cacheKey] = activityPreviewDiff;
        return activityPreviewDiff;
      }

      const liveDiff = await getGitDiff({
        runId,
        sessionId,
        path: file.path,
        staged: file.isStaged,
      });
      diffSnapshotsByMessageRef.current[cacheKey] = liveDiff;
      return liveDiff;
    },
    [artifactSourcesByAssistantMessageId, runId, sessionId],
  );
  const loadArtifactChangedFileDiff = useCallback(
    async (artifactId: string, file: FileStatus): Promise<DiffContent> => {
      const cacheKey = buildArtifactChangedFileDiffCacheKey(artifactId, file);
      const cachedDiff = diffSnapshotsByMessageRef.current[cacheKey];
      if (cachedDiff) {
        return cachedDiff;
      }

      const response = await getEditArtifactDiff({
        artifactId,
        path: file.path,
      });
      diffSnapshotsByMessageRef.current[cacheKey] = response.diff;
      return response.diff;
    },
    [],
  );
  useEffect(() => {
    pendingChangedFilesRef.current = [];
    turnBaselineFilesRef.current = [];
    lastSettledFilesRef.current = [];
    diffSnapshotsByMessageRef.current = {};
    artifactLookupMissesRef.current = new Set();
    inflightArtifactLookupsRef.current = new Set();
    previousIsLoadingRef.current = false;
    setChangedFilesByAssistantMessageId({});
    setArtifactSourcesByAssistantMessageId({});
  }, [runId]);

  useEffect(() => {
    const shouldCacheArtifactMisses =
      !isLoading &&
      (summary?.status ? isTerminalRunStatus(summary.status) : false);
    const assistantMessageIds = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.id)
      .filter(
        (messageId) =>
          !artifactSourcesByAssistantMessageId[messageId] &&
          !artifactLookupMissesRef.current.has(messageId) &&
          !inflightArtifactLookupsRef.current.has(messageId),
      );
    if (!runId || assistantMessageIds.length === 0) {
      return;
    }

    for (const messageId of assistantMessageIds) {
      inflightArtifactLookupsRef.current.add(messageId);
    }

    let cancelled = false;
    void Promise.allSettled(
      assistantMessageIds.map(async (assistantMessageId) => {
        const source = await getEditArtifactReviewSourceByMessage({
          runId,
          assistantMessageId,
        });
        return source ? ([assistantMessageId, source] as const) : null;
      }),
    ).then((results) => {
      if (cancelled) {
        return;
      }
      const nextEntries: Array<[string, PromptArtifactReviewSource]> = [];
      results.forEach((result, index) => {
        const assistantMessageId = assistantMessageIds[index];
        if (!assistantMessageId) {
          return;
        }
        inflightArtifactLookupsRef.current.delete(assistantMessageId);
        if (result.status === "fulfilled" && result.value) {
          nextEntries.push([...result.value]);
          return;
        }
        if (result.status === "rejected") {
          console.warn("[chat/artifacts] Failed to hydrate artifact", {
            assistantMessageId,
            error: result.reason,
          });
        }
        const shouldCacheNullArtifactMiss =
          result.status === "fulfilled" && result.value === null;
        const shouldCacheFailedArtifactMiss =
          shouldCacheArtifactMisses && result.status === "rejected";
        if (shouldCacheNullArtifactMiss || shouldCacheFailedArtifactMiss) {
          artifactLookupMissesRef.current.add(assistantMessageId);
        }
      });
      if (nextEntries.length === 0) {
        return;
      }
      setArtifactSourcesByAssistantMessageId((current) => ({
        ...current,
        ...Object.fromEntries(nextEntries),
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [
    artifactSourcesByAssistantMessageId,
    isLoading,
    messages,
    runId,
    summary?.status,
  ]);

  useEffect(() => {
    if (!previousIsLoadingRef.current && isLoading) {
      turnBaselineFilesRef.current = cloneFileStatuses(
        lastSettledFilesRef.current,
      );
      pendingChangedFilesRef.current = [];
      diffSnapshotsByMessageRef.current = {};
    }
    previousIsLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    const files = gitStatus?.files ?? [];
    if (!isLoading) {
      lastSettledFilesRef.current = cloneFileStatuses(files);
    }
    if (files.length === 0) {
      return;
    }
    pendingChangedFilesRef.current = collectChangedFilesSinceBaseline(
      files,
      turnBaselineFilesRef.current,
    );
  }, [gitStatus?.files, isLoading]);

  useEffect(() => {
    if (isLoading || !latestAssistantMessageId) {
      return;
    }

    const changedFiles =
      pendingChangedFilesRef.current.length > 0
        ? pendingChangedFilesRef.current
        : collectChangedFilesSinceBaseline(
            gitStatus?.files ?? [],
            turnBaselineFilesRef.current,
          );
    if (changedFiles.length === 0) {
      return;
    }

    setChangedFilesByAssistantMessageId((current) => {
      const nextFiles = cloneFileStatuses(changedFiles);
      if (
        areFileStatusListsEqual(current[latestAssistantMessageId], nextFiles)
      ) {
        return current;
      }
      return {
        ...current,
        [latestAssistantMessageId]: nextFiles,
      };
    });
  }, [gitStatus?.files, isLoading, latestAssistantMessageId]);

  useEffect(() => {
    setExpandedActivityTurns({});
    setExpandedActivityRows({});
  }, [runId]);

  useEffect(() => {
    if (scopedFeed?.status !== "RUNNING") {
      return;
    }

    const timerId = window.setInterval(() => {
      setActivityNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [runId, scopedFeed?.status]);

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

  const handleSubmitWithReviewComments =
    useCallback(async (): Promise<boolean> => {
      const budgetResult = validateReviewPromptBudget(
        selectedReviewComments,
        input,
      );
      if (!budgetResult.ok) {
        setReviewCommentError(budgetResult.reason);
        return false;
      }

      const { prompt } = buildReviewCommentPrompt(
        selectedReviewComments,
        input,
      );
      const selectedIds = selectedReviewComments.map((comment) => comment.id);
      lastReviewDispatchIdsRef.current = selectedIds;
      setReviewCommentError(null);
      markReviewCommentsDispatching(selectedIds);
      const previousInput = input;
      handleInputChangeWrapper("");

      try {
        await append({ role: "user", content: prompt });
        markReviewCommentsDispatched(selectedIds);
        return true;
      } catch (submitError) {
        markReviewCommentsDispatchFailed(selectedIds, { reselect: true });
        lastReviewDispatchIdsRef.current = [];
        handleInputChangeWrapper(previousInput);
        const message =
          submitError instanceof Error
            ? submitError.message
            : "Failed to send review comments.";
        setReviewCommentError(message);
        return false;
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
    if (
      lastAutoSwitchedPlanFailureKeyRef.current === latestAssistantMessageKey
    ) {
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
      if (isSubmittingApprovalDecisionRef.current) {
        return;
      }
      const pending = summary?.pendingApproval ?? pendingApprovalFromEvents;
      const isDismissedApproval =
        pending?.requestId === dismissedApprovalRequestId &&
        pending.createdAt === dismissedApprovalCreatedAt;
      if (!pending || isDismissedApproval) {
        return;
      }
      isSubmittingApprovalDecisionRef.current = true;
      setApprovalBusyDecision(decision);
      setApprovalError(null);
      setApprovalNotice(null);
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
                const retryMessage =
                  await readApprovalErrorMessage(retryResponse);
                const isRetryStaleApproval =
                  retryResponse.status === 409 ||
                  isNoPendingApprovalError(retryMessage);
                if (isRetryStaleApproval) {
                  setDismissedApprovalRequestId(latestPending.requestId);
                  setDismissedApprovalCreatedAt(latestPending.createdAt);
                  setApprovalNotice({
                    kind: "stale",
                    requestId: latestPending.requestId,
                  });
                  dispatchRunSummaryRefresh(runId);
                  return;
                }
                throw new Error(
                  retryMessage ||
                    `Failed to resolve approval (${retryResponse.status})`,
                );
              }
              setApprovalNotice({
                kind: "resolved",
                requestId: latestPending.requestId,
              });
              dispatchRunSummaryRefresh(runId);
              return;
            }

            setDismissedApprovalRequestId(pending.requestId);
            setDismissedApprovalCreatedAt(pending.createdAt);
            setApprovalNotice({
              kind: "stale",
              requestId: pending.requestId,
            });
            dispatchRunSummaryRefresh(runId);
            return;
          }
          throw new Error(
            message || `Failed to resolve approval (${response.status})`,
          );
        }
        setApprovalNotice({ kind: "resolved", requestId: pending.requestId });
        dispatchRunSummaryRefresh(runId);
      } catch (error) {
        setApprovalNotice(null);
        setApprovalError(
          error instanceof Error
            ? error.message
            : "Failed to resolve approval request.",
        );
      } finally {
        isSubmittingApprovalDecisionRef.current = false;
        setApprovalBusyDecision(null);
      }
    },
    [
      dismissedApprovalRequestId,
      dismissedApprovalCreatedAt,
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
      const isTerminal = isTerminalRunStatus(summary.status);
      const isApprovalWaiting = isApprovalRequiredRunStatus(summary.status);
      return isTerminal && !isApprovalWaiting
        ? null
        : pendingApprovalFromEvents;
    }

    return pendingApprovalFromEvents;
  }, [pendingApprovalFromEvents, summary]);
  const pendingApproval = useMemo(() => {
    if (!pendingApprovalCandidate) {
      return null;
    }
    if (
      pendingApprovalCandidate.requestId === dismissedApprovalRequestId &&
      pendingApprovalCandidate.createdAt === dismissedApprovalCreatedAt
    ) {
      return null;
    }
    return pendingApprovalCandidate;
  }, [
    dismissedApprovalCreatedAt,
    dismissedApprovalRequestId,
    pendingApprovalCandidate,
  ]);

  useEffect(() => {
    if (!pendingApprovalCandidate) {
      if (dismissedApprovalRequestId !== null) {
        setDismissedApprovalRequestId(null);
      }
      if (dismissedApprovalCreatedAt !== null) {
        setDismissedApprovalCreatedAt(null);
      }
      if (approvalNotice !== null) {
        setApprovalNotice(null);
      }
      return;
    }
    if (
      dismissedApprovalRequestId &&
      (pendingApprovalCandidate.requestId !== dismissedApprovalRequestId ||
        pendingApprovalCandidate.createdAt !== dismissedApprovalCreatedAt)
    ) {
      setDismissedApprovalRequestId(null);
      setDismissedApprovalCreatedAt(null);
      setApprovalError(null);
    }
    if (
      approvalNotice &&
      pendingApprovalCandidate.requestId !== approvalNotice.requestId
    ) {
      setApprovalNotice(null);
    }
  }, [
    approvalNotice,
    dismissedApprovalCreatedAt,
    dismissedApprovalRequestId,
    pendingApprovalCandidate,
  ]);

  useEffect(() => {
    if (!approvalNotice) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setApprovalNotice((currentNotice) =>
        currentNotice?.kind === approvalNotice.kind &&
        currentNotice.requestId === approvalNotice.requestId
          ? null
          : currentNotice,
      );
    }, APPROVAL_NOTICE_CLEAR_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [approvalNotice]);

  useEffect(() => {
    onPendingApprovalChange?.(Boolean(pendingApproval));
  }, [onPendingApprovalChange, pendingApproval]);
  const displayedApprovalDecisions = useMemo(
    () => getDisplayedApprovalDecisions(pendingApproval),
    [pendingApproval],
  );
  const approvalNoticeText = getApprovalNoticeText(approvalNotice);
  const isApprovalResolutionPending =
    approvalNotice?.kind === "resolved" &&
    pendingApproval?.requestId === approvalNotice.requestId;
  const chatEntries = useMemo(
    () => buildChatEntries(conversationTurns, activityViewModel.turns, runId),
    [activityViewModel.turns, conversationTurns, runId],
  );
  const terminalChangedFiles = useMemo(
    () => collectActivityChangedFiles(activityViewModel.turns),
    [activityViewModel.turns],
  );
  const hasAssistantChangedFileSummary = useMemo(
    () =>
      hasChangedFileSnapshot(changedFileSnapshotsByAssistantMessageId) ||
      hasArtifactChangedFileSnapshot(artifactSourcesByAssistantMessageId),
    [
      artifactSourcesByAssistantMessageId,
      changedFileSnapshotsByAssistantMessageId,
    ],
  );
  const terminalViewModel = useMemo(
    () =>
      buildRunTerminalViewModel({
        runId,
        summary,
        events,
        hasVisibleAssistantMessage: hasVisibleAssistantReply(conversationTurns),
        changedFileCount:
          terminalChangedFiles.length > 0
            ? terminalChangedFiles.length
            : undefined,
      }),
    [conversationTurns, events, runId, summary, terminalChangedFiles.length],
  );
  const terminalReviewFiles = useMemo(() => {
    if (!terminalViewModel) {
      return [];
    }
    if (terminalViewModel.artifactId) {
      return terminalChangedFiles;
    }
    return hasAssistantChangedFileSummary ? [] : terminalChangedFiles;
  }, [hasAssistantChangedFileSummary, terminalChangedFiles, terminalViewModel]);
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
  const hasConversationSignal = hasUserMessage || chatEntries.length > 0;
  const showHeroComposer =
    hasHydrated &&
    !hasConversationSignal &&
    !activeRunLoading &&
    !pendingApproval &&
    !hasStartedSession;
  const isTranscriptHydrating =
    !hasHydrated && !hasConversationSignal && !pendingApproval;
  const showSessionPlaceholder =
    isTranscriptHydrating ||
    (hasStartedSession &&
      hasHydrated &&
      !hasConversationSignal &&
      !pendingApproval &&
      !showHeroComposer);
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
        <ApprovalDock
          pendingApproval={pendingApproval}
          decisions={displayedApprovalDecisions}
          busyDecision={approvalBusyDecision}
          error={approvalError}
          notice={approvalNoticeText}
          isResolutionPending={isApprovalResolutionPending}
          onResolve={resolveApprovalDecision}
        />
      ) : (
        <ChatInputBar
          input={input}
          onChange={handleInputChangeWrapper}
          onSubmit={
            selectedReviewComments.length > 0
              ? () => handleSubmitWithReviewComments()
              : (attachments) => handleSubmit(undefined, attachments)
          }
          reviewComments={selectedReviewComments}
          onRemoveReviewComment={handleRemoveReviewComment}
          reviewCommentError={reviewCommentError}
          onStop={stop}
          canStop={activeRunLoading && (canStop ?? true)}
          isLoading={activeRunLoading || isTranscriptHydrating}
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
        isLoading={activeRunLoading || isTranscriptHydrating}
      />
    </>
  );

  // Auto-scroll to bottom on new messages and live activity updates.
  useEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) {
      return;
    }

    const scrollScopeKey = `${sessionId}:${runId}`;
    const isInitialScopeScroll =
      previousScrollScopeKeyRef.current !== scrollScopeKey;
    previousScrollScopeKeyRef.current = scrollScopeKey;

    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: isInitialScopeScroll ? "auto" : "smooth",
    });
  }, [activityScrollSignal, isLoading, messages, runId, sessionId]);

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
        ) : showSessionPlaceholder ? (
          <ChatLoadingIndicator />
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
                    snapshots: changedFileSnapshotsByAssistantMessageId,
                    artifacts: artifactSourcesByAssistantMessageId,
                    loadFileDiff: (file) =>
                      loadChangedFileDiff(entry.message.id, file),
                    onPromptArtifactReview: (artifactId) => {
                      openPromptArtifactReview(artifactId, entry.message.id);
                      onReviewOpen?.();
                    },
                  })}
                />
              ) : (
                renderActivityTurn(entry.turn)
              ),
            )}

            {terminalViewModel ? (
              <ChatMessage
                message={{
                  id: terminalViewModel.id,
                  role: "assistant",
                  content: terminalViewModel.content,
                }}
                changedFilesSummary={resolveTerminalChangedFilesSummary({
                  terminalViewModel,
                  files: terminalReviewFiles,
                  loadArtifactFileDiff: loadArtifactChangedFileDiff,
                  loadFallbackFileDiff: (file) =>
                    loadChangedFileDiff(terminalViewModel.id, file),
                  onPromptArtifactReview: (artifactId) => {
                    openPromptArtifactReview(artifactId);
                    onReviewOpen?.();
                  },
                  onReviewOpen,
                })}
              />
            ) : null}

            {/* Loading indicator */}
            {activeRunLoading && !activeInlineTurn && (
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
  snapshots: Record<string, FileStatus[]>;
  artifacts: Record<string, PromptArtifactReviewSource>;
  loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
  onPromptArtifactReview: (artifactId: string) => void;
}):
  | {
      files: FileStatus[];
      loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
      onReviewOpen?: () => void;
    }
  | undefined {
  const artifact = input.artifacts[input.messageId];
  if (artifact?.files.length) {
    return {
      files: artifact.files.map(mapReviewFileToStatus),
      loadFileDiff: input.loadFileDiff,
      onReviewOpen: () => input.onPromptArtifactReview(artifact.artifactId),
    };
  }

  const files = input.snapshots[input.messageId];
  if (!files?.length) {
    return undefined;
  }

  return {
    files,
    loadFileDiff: input.loadFileDiff,
  };
}

function mapReviewFileToStatus(
  file: PromptArtifactReviewSource["files"][number],
): FileStatus {
  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    isStaged: file.isStaged ?? false,
  };
}

function mergeChangedFileSnapshots(
  localSnapshots: Record<string, FileStatus[]>,
  activitySnapshots: Record<string, FileStatus[]>,
): Record<string, FileStatus[]> {
  return {
    ...localSnapshots,
    ...activitySnapshots,
  };
}

function hasChangedFileSnapshot(
  snapshots: Record<string, FileStatus[]>,
): boolean {
  return Object.values(snapshots).some((files) => files.length > 0);
}

function hasArtifactChangedFileSnapshot(
  artifacts: Record<string, PromptArtifactReviewSource>,
): boolean {
  return Object.values(artifacts).some((artifact) => artifact.files.length > 0);
}

function buildChangedFileDiffCacheKey(
  messageId: string,
  file: FileStatus,
): string {
  return `${messageId}:${file.path}:${file.isStaged ? "staged" : "unstaged"}`;
}

function buildArtifactChangedFileDiffCacheKey(
  artifactId: string,
  file: FileStatus,
): string {
  return `artifact:${artifactId}:${file.path}`;
}

function resolveTerminalChangedFilesSummary(input: {
  terminalViewModel: RunTerminalViewModel;
  files: FileStatus[];
  loadArtifactFileDiff: (
    artifactId: string,
    file: FileStatus,
  ) => Promise<DiffContent>;
  loadFallbackFileDiff: (file: FileStatus) => Promise<DiffContent>;
  onPromptArtifactReview: (artifactId: string) => void;
  onReviewOpen?: () => void;
}):
  | {
      files: FileStatus[];
      loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
      onReviewOpen?: () => void;
    }
  | undefined {
  if (input.files.length === 0) {
    return undefined;
  }

  if (input.terminalViewModel.artifactId) {
    const artifactId = input.terminalViewModel.artifactId;
    return {
      files: input.files,
      loadFileDiff: (file) => input.loadArtifactFileDiff(artifactId, file),
      onReviewOpen: () => input.onPromptArtifactReview(artifactId),
    };
  }

  return {
    files: input.files,
    loadFileDiff: input.loadFallbackFileDiff,
    onReviewOpen: input.onReviewOpen,
  };
}

function buildDiffFromActivityPreview(file: FileStatus): DiffContent | null {
  const diffPreview = readActivityDiffPreview(file);
  if (!diffPreview) {
    return null;
  }

  const lines = buildDiffLinesFromActivityPreview(diffPreview);
  if (!lines.some((line) => line.type === "added" || line.type === "deleted")) {
    return null;
  }

  return {
    oldPath: file.path,
    newPath: file.path,
    isBinary: false,
    isNewFile: file.status === "added",
    isDeleted: file.status === "deleted",
    hunks: [
      {
        oldStart: 1,
        oldLines: lines.filter((line) => line.type !== "added").length,
        newStart: 1,
        newLines: lines.filter((line) => line.type !== "deleted").length,
        header: "Saved edit preview",
        lines,
      },
    ],
  };
}

function readActivityDiffPreview(file: FileStatus): string | null {
  const candidate = file as FileStatus & { diffPreview?: unknown };
  if (typeof candidate.diffPreview !== "string") {
    return null;
  }
  const trimmed = candidate.diffPreview.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildDiffLinesFromActivityPreview(
  diffPreview: string,
): DiffContent["hunks"][number]["lines"] {
  let oldLineNumber = 1;
  let newLineNumber = 1;
  return diffPreview
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => {
      if (line.startsWith("+")) {
        return {
          type: "added" as const,
          content: line,
          newLineNumber: newLineNumber++,
        };
      }
      if (line.startsWith("-")) {
        return {
          type: "deleted" as const,
          content: line,
          oldLineNumber: oldLineNumber++,
        };
      }
      const diffLine = {
        type: "unchanged" as const,
        content: line,
        oldLineNumber,
        newLineNumber,
      };
      oldLineNumber += 1;
      newLineNumber += 1;
      return diffLine;
    });
}

function collectChangedFilesSinceBaseline(
  files: FileStatus[],
  baselineFiles: FileStatus[],
): FileStatus[] {
  if (baselineFiles.length === 0) {
    return cloneFileStatuses(files);
  }

  const baselineByPath = new Map(
    baselineFiles.map((file) => [file.path, fileStatusSignature(file)]),
  );
  return files
    .filter(
      (file) => baselineByPath.get(file.path) !== fileStatusSignature(file),
    )
    .map((file) => ({ ...file }));
}

function fileStatusSignature(file: FileStatus): string {
  return [
    file.status,
    file.additions,
    file.deletions,
    file.isStaged ? "staged" : "unstaged",
  ].join(":");
}

function areFileStatusListsEqual(
  left: FileStatus[] | undefined,
  right: FileStatus[],
): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }

  return left.every((file, index) => {
    const rightFile = right[index];
    return (
      rightFile !== undefined &&
      file.path === rightFile.path &&
      fileStatusSignature(file) === fileStatusSignature(rightFile)
    );
  });
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

  const payload = RunSummaryPendingApprovalSchema.safeParse(
    await response.json(),
  );
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
      pendingByRequestId.set(
        event.payload.request.requestId,
        event.payload.request,
      );
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

function isVisibleTerminalAssistantMessage(message: Message): boolean {
  if (message.role !== "assistant") {
    return false;
  }

  const metadata = readAssistantMessageMetadata(message);
  if (
    typeof metadata?.terminalState === "string" ||
    metadata?.finalMessageSource === "model" ||
    metadata?.finalMessageSource === "runtime"
  ) {
    return true;
  }

  return hasTerminalSummaryFrame(message.content);
}

function isVisibleAssistantMessage(message: Message): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (isVisibleTerminalAssistantMessage(message)) {
    return true;
  }
  return readMessageVisibleText(message).length > 0;
}

function hasVisibleAssistantReply(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
): boolean {
  return conversationTurns.some(
    (turn) =>
      Boolean(turn.userMessage) &&
      Boolean(
        turn.assistantMessage &&
        isVisibleAssistantMessage(turn.assistantMessage),
      ),
  );
}

function readAssistantMessageMetadata(
  message: Message,
): Record<string, unknown> | null {
  const data = (message as Message & { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const metadata = (data as Record<string, unknown>).metadata;
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : null;
}

function hasTerminalSummaryFrame(content: Message["content"]): boolean {
  const text = readVisibleText(content);
  return (
    text.includes("Outcome:") &&
    (text.includes("Next action:") || text.includes("Next step:"))
  );
}

function readMessageVisibleText(message: Message): string {
  return readVisibleText(message.content);
}

function readVisibleText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("")
    .trim();
}

type ChatInterfaceEntry =
  | { kind: "message"; message: Message }
  | { kind: "turn"; turn: ActivityTurnViewModel };

function buildChatEntries(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
  turns: ActivityTurnViewModel[],
  runId: string,
): ChatInterfaceEntry[] {
  const entries: ChatInterfaceEntry[] = [];
  const activityTurnsByMessageId = correlateActivityTurnsToMessages(
    conversationTurns,
    turns,
    { logUnmatched: false, runId },
  );
  const assignedActivityTurnKeys = new Set<string>();

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
          assignedActivityTurnKeys.add(activityTurn.key);
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

  if (entries.length === 0) {
    appendUnmatchedActivityTurns(entries, turns, assignedActivityTurnKeys);
  }
  return entries;
}

function appendUnmatchedActivityTurns(
  entries: ChatInterfaceEntry[],
  turns: ActivityTurnViewModel[],
  assignedActivityTurnKeys: Set<string>,
): void {
  for (const turn of turns) {
    if (!turn.hasVisibleRows || assignedActivityTurnKeys.has(turn.key)) {
      continue;
    }

    const prompt = turn.userPrompt?.trim();
    if (prompt) {
      entries.push({
        kind: "message",
        message: {
          id: `activity:${turn.key}:user`,
          role: "user",
          content: prompt,
        },
      });
    }
    entries.push({ kind: "turn", turn });
  }
}

function correlateActivityTurnsToMessages(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
  turns: ActivityTurnViewModel[],
  options: { logUnmatched?: boolean; runId?: string } = {},
): Map<string, ActivityTurnViewModel[]> {
  const logUnmatched = options.logUnmatched ?? true;
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

  for (
    let activityIndex = turns.length - 1;
    activityIndex >= 0;
    activityIndex -= 1
  ) {
    const activityTurn = turns[activityIndex];
    if (!activityTurn?.hasVisibleRows) {
      continue;
    }

    const matchedIndex = findMatchingConversationTurnIndex(
      conversationUserTurns,
      availableConversationTurnIndexes,
      activityTurn.userPrompt,
    );
    if (matchedIndex === null) {
      if (logUnmatched) {
        warnUnmatchedActivityTurn(options.runId, activityTurn.key);
      }
      continue;
    }

    const matchedConversationTurn = conversationUserTurns[matchedIndex];
    if (!matchedConversationTurn) {
      console.warn(
        "[chat/transcript] Activity turn matched an unavailable user message index.",
        {
          activityTurnKey: activityTurn.key,
          matchedIndex,
          runId: options.runId,
        },
      );
      availableConversationTurnIndexes.delete(matchedIndex);
      continue;
    }

    availableConversationTurnIndexes.delete(matchedIndex);
    const existingAssignments =
      assignments.get(matchedConversationTurn.userMessage.id) ?? [];
    existingAssignments.unshift(activityTurn);
    assignments.set(
      matchedConversationTurn.userMessage.id,
      existingAssignments,
    );
  }

  return assignments;
}

const unmatchedActivityWarningKeys = new Set<string>();
const MAX_UNMATCHED_ACTIVITY_WARNING_KEYS = 500;

function warnUnmatchedActivityTurn(
  runId: string | undefined,
  activityTurnKey: string,
): void {
  const warningKey = `${runId ?? "unknown"}:${activityTurnKey}`;
  if (unmatchedActivityWarningKeys.has(warningKey)) {
    return;
  }

  if (
    unmatchedActivityWarningKeys.size >= MAX_UNMATCHED_ACTIVITY_WARNING_KEYS
  ) {
    unmatchedActivityWarningKeys.clear();
  }
  unmatchedActivityWarningKeys.add(warningKey);

  console.warn(
    "[chat/transcript] Activity turn could not be correlated to a user message.",
    { activityTurnKey, runId },
  );
}

function deriveActivityChangedFilesByAssistantMessageId(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
  turns: ActivityTurnViewModel[],
): Record<string, FileStatus[]> {
  const assignments = correlateActivityTurnsToMessages(
    conversationTurns,
    turns,
    {
      logUnmatched: false,
    },
  );
  const snapshots: Record<string, FileStatus[]> = {};

  for (const conversationTurn of conversationTurns) {
    if (!conversationTurn.userMessage || !conversationTurn.assistantMessage) {
      continue;
    }

    const activityTurns =
      assignments.get(conversationTurn.userMessage.id) ?? [];

    const changedFiles = collectActivityChangedFiles(activityTurns);
    if (changedFiles.length > 0) {
      snapshots[conversationTurn.assistantMessage.id] = changedFiles;
    }
  }

  return snapshots;
}

function collectActivityChangedFiles(
  turns: ActivityTurnViewModel[],
): FileStatus[] {
  const filesByPath = new Map<string, FileStatus>();
  for (const turn of turns) {
    for (const row of turn.rows) {
      collectChangedFilesFromActivityRow(row, filesByPath);
    }
  }
  return [...filesByPath.values()];
}

function collectChangedFilesFromActivityRow(
  row: ActivityTurnViewModel["rows"][number],
  filesByPath: Map<string, FileStatus>,
): void {
  if (row.kind === "group") {
    for (const childRow of row.rows) {
      collectChangedFilesFromActivityRow(childRow, filesByPath);
    }
    return;
  }

  if (row.kind !== "tool" || !row.changedFile) {
    return;
  }

  const existing = filesByPath.get(row.changedFile.path);
  if (!existing) {
    filesByPath.set(row.changedFile.path, { ...row.changedFile });
    return;
  }

  filesByPath.set(row.changedFile.path, {
    ...existing,
    additions: existing.additions + row.changedFile.additions,
    deletions: existing.deletions + row.changedFile.deletions,
  });
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

  const fuzzyMatches: number[] = [];
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
    if (arePromptsFuzzyMatch(conversationPrompt, normalizedUserPrompt)) {
      fuzzyMatches.push(index);
    }
  }

  if (fuzzyMatches.length === 0) {
    return null;
  }

  return (
    fuzzyMatches.sort(
      (a, b) =>
        Math.abs(a - conversationTurns.length) -
        Math.abs(b - conversationTurns.length),
    )[0] ?? null
  );
}

function normalizePromptForMatching(
  content: string | null | undefined,
): string {
  if (typeof content !== "string") {
    return "";
  }

  return content
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/@(?=[\w./-])/g, "")
    .replace(/\s+/g, " ");
}

function arePromptsFuzzyMatch(left: string, right: string): boolean {
  if (left.length < 12 || right.length < 12) {
    return false;
  }
  if (left.includes(right) || right.includes(left)) {
    return true;
  }

  const leftTokens = tokenizePrompt(left);
  const rightTokens = tokenizePrompt(right);
  if (leftTokens.size < 3 || rightTokens.size < 3) {
    return false;
  }

  let sharedTokenCount = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      sharedTokenCount += 1;
    }
  }

  const overlapRatio =
    sharedTokenCount / Math.max(leftTokens.size, rightTokens.size);
  return overlapRatio >= 0.8;
}

function tokenizePrompt(prompt: string): Set<string> {
  return new Set(
    prompt
      .split(/[^a-z0-9./-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
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
