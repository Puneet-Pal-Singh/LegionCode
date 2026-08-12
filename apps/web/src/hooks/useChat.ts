import { type FormEvent } from "react";
import type { Message } from "@ai-sdk/react";
import type { ProductMode, RunMode } from "@repo/shared-types";
import { useChatCore, type ChatAppendMessage } from "./useChatCore";
import { useChatHydration } from "./useChatHydration";
import { useChatPersistence } from "./useChatPersistence";
import { useChatArtifacts } from "./useChatArtifacts";
import type { ArtifactState } from "../types/chat";
import type { ChatDebugEvent } from "../types/chat-debug.js";
import type { ChatSubmitAttachments } from "../components/chat/chatImageAttachments";
import type { ConversationScope } from "./conversationScope";
import type { ActiveTurnProjection } from "./useActiveTurnProjection";

interface UseChatResult {
  messages: Message[];
  input: string;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (
    e?: FormEvent,
    attachments?: ChatSubmitAttachments,
  ) => Promise<boolean>;
  append: (message: ChatAppendMessage) => Promise<void>;
  isLoading: boolean;
  isHydrating: boolean;
  hasHydrated: boolean;
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
): UseChatResult {
  // Core chat functionality
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    append,
    isLoading,
    stop,
    setMessages,
    runId: activeRunId,
    scope,
    serverTurnId,
    activeTurnProjection,
    resetRun,
    isModelConfigReady,
    error,
    clearNonCanonicalError,
    debugEvents,
  } = useChatCore(sessionId, runId, mode, productMode);

  // Handle message hydration
  const { isHydrating, hasHydrated } = useChatHydration(
    scope,
    messages,
    setMessages,
    activeTurnProjection.isTerminal && activeTurnProjection.projection
      ? `${activeTurnProjection.turnId}:${activeTurnProjection.projection.lastSequence}`
      : null,
  );

  // Handle message persistence
  useChatPersistence({
    scope,
    messages,
  });

  // Handle artifact state
  const artifactState = useChatArtifacts({
    messages,
    onFileCreated,
  });

  return {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    append,
    isLoading,
    isHydrating,
    hasHydrated,
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
