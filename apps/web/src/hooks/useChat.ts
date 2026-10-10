import { type FormEvent, useCallback, useMemo, useState } from "react";
import type { Message } from "@ai-sdk/react";
import type { ProductMode, RunMode } from "@repo/shared-types";
import { useChatCore, type ChatAppendMessage } from "./useChatCore";
import type { SubmissionOutcome } from "./chat/submissionAttemptRegistry";
import { useChatHydration } from "./useChatHydration";
import { useChatPersistence } from "./useChatPersistence";
import { useChatArtifacts } from "./useChatArtifacts";
import type { ArtifactState } from "../types/chat";
import type { ChatDebugEvent } from "../types/chat-debug.js";
import type { ChatSubmitAttachments } from "@legioncode/client-ui";
import type { ConversationScope } from "./conversationScope";
import type { HydrationStatus } from "../services/ChatHydrationService";
import type { ActiveTurnProjection } from "./useActiveTurnProjection";

export interface UseChatResult {
  messages: Message[];
  optimisticUserMessageId: string | null;
  input: string;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (
    e?: FormEvent,
    attachments?: ChatSubmitAttachments,
  ) => Promise<boolean>;
  append: (message: ChatAppendMessage) => Promise<SubmissionOutcome>;
  reviseTurn: (turnId: string, content: string) => Promise<boolean>;
  isLoading: boolean;
  isHydrating: boolean;
  hasHydrated: boolean;
  hydrationStatus: HydrationStatus | "loading" | "idle";
  hydrationError: string | null;
  retryHydration: () => void;
  stop: () => void;
  artifactState: ArtifactState;
  runId: string;
  scope: ConversationScope | null;
  serverTurnId: string | null;
  activeTurnProjection: ActiveTurnProjection;
  resetRun: () => void;
  isModelConfigReady: boolean;
  error: string | null;
  clearNonCanonicalError: () => void;
  debugEvents: ChatDebugEvent[];
}

/**
 * useChat
 * Main hook that composes all chat-related functionality
 * Orchestrates: Core chat, hydration, persistence, and artifacts
 */
export function useChat(
  sessionId: string,
  runId?: string,
  onFileCreated?: () => void,
  mode?: RunMode,
  productMode?: ProductMode,
  onServerProjectionAvailable?: () => void,
  isSessionPersistenceReady = true,
): UseChatResult {
  const [transcriptState, setTranscriptState] = useState<{
    sessionId: string;
    messages: Message[];
  }>(() => ({ sessionId, messages: [] }));
  const verifiedMessages = useMemo(
    () =>
      transcriptState.sessionId === sessionId ? transcriptState.messages : [],
    [transcriptState, sessionId],
  );
  const setVerifiedMessages = useCallback(
    (messages: Message[]) => setTranscriptState({ sessionId, messages }),
    [sessionId],
  );
  const {
    optimisticUserMessage,
    optimisticUserMessageId,
    input,
    handleInputChange,
    handleSubmit,
    append,
    reviseTurn,
    isLoading,
    stop,
    runId: activeRunId,
    scope,
    serverTurnId,
    activeTurnProjection,
    resetRun,
    isModelConfigReady,
    error,
    clearNonCanonicalError,
    debugEvents,
  } = useChatCore(
    sessionId,
    runId,
    mode,
    productMode,
    onServerProjectionAvailable,
  );

  const messages = useMemo(() => {
    const verifiedIds = new Set(verifiedMessages.map((message) => message.id));
    return [
      ...verifiedMessages,
      ...(optimisticUserMessage && !verifiedIds.has(optimisticUserMessage.id)
        ? [optimisticUserMessage]
        : []),
    ];
  }, [optimisticUserMessage, verifiedMessages]);

  // Handle message hydration
  const {
    isHydrating,
    hasHydrated,
    status: hydrationStatus,
    error: hydrationError,
    retry: retryHydration,
  } = useChatHydration(
    sessionId,
    verifiedMessages,
    setVerifiedMessages,
    activeTurnProjection.isTerminal && activeTurnProjection.projection
      ? `${activeRunId}:${activeTurnProjection.turnId}:terminal:${activeTurnProjection.projection.lastSequence}`
      : activeTurnProjection.projection?.startedAt
        ? `${activeRunId}:${activeTurnProjection.turnId}:started`
        : `${activeRunId}:initial`,
    isSessionPersistenceReady,
  );
  const reviseTurnAfterAcceptance = useCallback(
    async (turnId: string, content: string) => {
      const accepted = await reviseTurn(turnId, content);
      if (accepted) retryHydration();
      return accepted;
    },
    [reviseTurn, retryHydration],
  );

  // Handle message persistence
  useChatPersistence({
    scope,
    messages: verifiedMessages,
  });

  // Handle artifact state
  const artifactState = useChatArtifacts({
    messages: verifiedMessages,
    onFileCreated,
  });

  return {
    messages,
    optimisticUserMessageId,
    input,
    handleInputChange,
    handleSubmit,
    append,
    reviseTurn: reviseTurnAfterAcceptance,
    isLoading,
    isHydrating,
    hasHydrated,
    hydrationStatus,
    hydrationError,
    retryHydration,
    stop,
    artifactState,
    runId: activeRunId,
    scope,
    serverTurnId,
    activeTurnProjection,
    resetRun,
    isModelConfigReady,
    error,
    clearNonCanonicalError,
    debugEvents,
  };
}
