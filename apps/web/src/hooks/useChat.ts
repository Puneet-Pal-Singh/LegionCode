import { useMemo, type FormEvent } from "react";
import type { Message } from "@ai-sdk/react";
import type { ProductMode, RunMode } from "@repo/shared-types";
import { useChatCore } from "./useChatCore";
import { useChatHydration } from "./useChatHydration";
import { useChatPersistence } from "./useChatPersistence";
import { useChatArtifacts } from "./useChatArtifacts";
import type { ArtifactState } from "../types/chat";
import type { ChatDebugEvent } from "../types/chat-debug.js";
import type { ChatSubmitAttachments } from "../components/chat/chatImageAttachments";
import {
  createConversationScope,
  type ConversationScope,
} from "./conversationScope";

interface UseChatResult {
  messages: Message[];
  input: string;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (
    e?: FormEvent,
    attachments?: ChatSubmitAttachments,
  ) => Promise<boolean>;
  append: (message: { role: "user"; content: string }) => Promise<void>;
  isLoading: boolean;
  isHydrating: boolean;
  hasHydrated: boolean;
  stop: () => void;
  artifactState: ArtifactState;
  runId: string;
  serverTurnId: string | null;
  resetRun: () => void;
  isModelConfigReady: boolean;
  error: string | null;
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
  workspaceId?: string,
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
    serverTurnId,
    resetRun,
    isModelConfigReady,
    error,
    debugEvents,
  } = useChatCore(sessionId, runId, mode, productMode, workspaceId);

  const scope: ConversationScope = useMemo(
    () =>
      createConversationScope({
        workspaceId: workspaceId ?? sessionId,
        sessionId,
        runId: activeRunId,
      }),
    [activeRunId, sessionId, workspaceId],
  );

  // Handle message hydration
  const { isHydrating, hasHydrated } = useChatHydration(
    scope,
    messages,
    setMessages,
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
    serverTurnId,
    resetRun,
    isModelConfigReady,
    error,
    debugEvents,
  };
}
