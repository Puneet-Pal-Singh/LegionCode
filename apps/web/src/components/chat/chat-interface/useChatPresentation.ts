import { useMemo } from "react";
import type { Message } from "@ai-sdk/react";
import type {
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import type { ActivityTurnViewModel } from "../../../services/activity/ActivityFeedViewModel.js";
import { buildRunTerminalViewModel } from "../../../services/workflow/RunTerminalViewModel.js";
import {
  buildLifecycleTerminalViewModel,
  collectLifecycleTurnDiffFiles,
} from "../../../services/lifecycle/LifecycleTerminalViewModel";
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import type { useRunEvents } from "../../../hooks/useRunEvents.js";
import type { useRunSummary } from "../../../hooks/useRunSummary.js";
import { buildConversationTurns } from "../messageMetadata";
import {
  hasArtifactChangedFileSnapshot,
  hasChangedFileSnapshot,
} from "./changedFiles";
import { buildChatEntries, collectActivityChangedFiles } from "./chatEntries";
import { hasVisibleAssistantReply } from "./messageVisibility";

interface ChatPresentationInput {
  runId: string;
  messages: Message[];
  conversationTurns: ReturnType<typeof buildConversationTurns>;
  activityTurns: ActivityTurnViewModel[];
  summary: ReturnType<typeof useRunSummary>["summary"];
  events: ReturnType<typeof useRunEvents>["events"];
  snapshots: Record<string, FileStatus[]>;
  artifacts: Record<string, PromptArtifactReviewSource>;
  hasHydrated: boolean;
  isLoading: boolean;
  hasPendingApproval: boolean;
  hasStartedSession: boolean;
  lifecycleProjection?: LifecycleProjection | null;
}

export function useChatPresentation(input: ChatPresentationInput) {
  const chatEntries = useMemo(
    () =>
      buildChatEntries(
        input.conversationTurns,
        input.activityTurns,
        input.runId,
      ),
    [input.activityTurns, input.conversationTurns, input.runId],
  );
  const activityTerminalFiles = useMemo(
    () => collectActivityChangedFiles(input.activityTurns),
    [input.activityTurns],
  );
  const lifecycleTerminalFiles = useMemo(
    () => collectLifecycleTurnDiffFiles(input.lifecycleProjection ?? null),
    [input.lifecycleProjection],
  );
  const terminalFiles =
    lifecycleTerminalFiles.length > 0
      ? lifecycleTerminalFiles
      : activityTerminalFiles;
  const terminalViewModel = useMemo(
    () =>
      buildLifecycleTerminalViewModel(input.lifecycleProjection ?? null) ??
      buildRunTerminalViewModel({
          runId: input.runId,
          summary: input.summary,
          events: input.events,
          hasVisibleAssistantMessage: hasVisibleAssistantReply(
            input.conversationTurns,
          ),
          changedFileCount: terminalFiles.length || undefined,
        }),
    [input, terminalFiles.length],
  );
  const hasFileSummary =
    hasChangedFileSnapshot(input.snapshots) ||
    hasArtifactChangedFileSnapshot(input.artifacts);
  const terminalReviewFiles = terminalViewModel?.artifactId
    ? terminalFiles
    : hasFileSummary
      ? []
      : terminalFiles;
  const hasUserMessage = input.messages.some(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.trim().length > 0,
  );
  const hasConversation = hasUserMessage || chatEntries.length > 0;
  const showHeroComposer =
    input.hasHydrated &&
    !hasConversation &&
    !input.isLoading &&
    !input.hasPendingApproval &&
    !input.hasStartedSession;
  const isTranscriptHydrating =
    !input.hasHydrated && !hasConversation && !input.hasPendingApproval;
  const showSessionPlaceholder =
    isTranscriptHydrating ||
    (input.hasStartedSession &&
      input.hasHydrated &&
      !hasConversation &&
      !input.hasPendingApproval &&
      !showHeroComposer);

  return {
    chatEntries,
    terminalViewModel,
    terminalReviewFiles,
    showHeroComposer,
    isTranscriptHydrating,
    showSessionPlaceholder,
  };
}
