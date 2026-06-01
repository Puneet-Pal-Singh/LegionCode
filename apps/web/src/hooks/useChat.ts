import type { FormEvent } from "react";
import type { Message } from "@ai-sdk/react";
import type { ProductMode, RunMode } from "@repo/shared-types";
import { useChatCore } from "./useChatCore";
import { useChatHydration } from "./useChatHydration";
import { useChatPersistence } from "./useChatPersistence";
import { useChatArtifacts } from "./useChatArtifacts";
import type { ArtifactState } from "../types/chat";
import type { ChatDebugEvent } from "../types/chat-debug.js";
import type { ChatSubmitAttachments } from "../components/chat/chatImageAttachments";

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
  allowPendingQueryRestore = true,
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
    resetRun,
    isModelConfigReady,
    error,
    debugEvents,
  } = useChatCore(sessionId, runId, mode, productMode);

  // Handle message hydration
  const { isHydrating, hasHydrated } = useChatHydration(
    sessionId,
    activeRunId,
    messages.length,
    setMessages,
  );

  // Handle message persistence
  useChatPersistence({
    sessionId,
    runId: activeRunId,
    messages,
    messagesLength: messages.length,
    isLoading,
    append,
    isModelConfigReady,
    allowPendingQueryRestore,
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
    resetRun,
    isModelConfigReady,
    error,
    debugEvents,
  };
}
