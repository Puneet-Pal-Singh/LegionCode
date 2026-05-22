import { useEffect, useMemo, useRef } from "react";
import type { Message } from "@ai-sdk/react";
import { ChatPersistenceService } from "../services/ChatPersistenceService";
import { ProviderApiError } from "../services/api/providerClient.js";

interface UseChatPersistenceProps {
  sessionId: string;
  runId: string;
  messages: Message[];
  messagesLength: number;
  isLoading: boolean;
  isModelConfigReady: boolean;
  append: (message: { role: "user"; content: string }) => Promise<void>;
}

/**
 * useChatPersistence
 * Manages message persistence and pending query restoration
 * Single Responsibility: Only manage persistence lifecycle
 */
export function useChatPersistence({
  sessionId,
  runId,
  messages,
  messagesLength,
  isLoading,
  isModelConfigReady,
  append,
}: UseChatPersistenceProps): void {
  const persistenceService = useMemo(() => new ChatPersistenceService(), []);
  const attemptedRestoreKeyRef = useRef<string | null>(null);

  // Sync messages to global store
  useEffect(() => {
    persistenceService.syncToStore(runId, messages);
  }, [messages, runId, persistenceService]);

  // Restore pending query from localStorage
  useEffect(() => {
    const pendingQuery = persistenceService.getPendingQuery(sessionId);
    if (!pendingQuery) {
      attemptedRestoreKeyRef.current = null;
      return;
    }
    if (!isModelConfigReady) {
      return;
    }
    if (!persistenceService.shouldRestorePendingQuery(messagesLength, isLoading)) {
      return;
    }
    const restoreKey = `${sessionId}:${pendingQuery}`;
    if (attemptedRestoreKeyRef.current === restoreKey) {
      return;
    }
    attemptedRestoreKeyRef.current = restoreKey;

    const restorePendingQuery = async (): Promise<void> => {
      try {
        await append({ role: "user", content: pendingQuery });
        persistenceService.clearPendingQuery(sessionId);
        attemptedRestoreKeyRef.current = null;
      } catch (error) {
        if (shouldDropPendingQuery(error)) {
          persistenceService.clearPendingQuery(sessionId);
          attemptedRestoreKeyRef.current = null;
          console.warn(
            "[useChatPersistence] Dropping stale pending query after non-retryable restore error",
            error,
          );
          return;
        }
        console.error("[useChatPersistence] Failed to restore pending query", error);
      }
    };

    void restorePendingQuery();
  }, [
    sessionId,
    messagesLength,
    isLoading,
    isModelConfigReady,
    append,
    persistenceService,
  ]);
}

function shouldDropPendingQuery(error: unknown): boolean {
  if (error instanceof ProviderApiError) {
    return error.statusCode >= 400 && error.statusCode < 500;
  }
  return (
    error instanceof Error &&
    (error.message.includes("No provider connected") ||
      error.message.includes("No BYOK provider connected") ||
      error.message.includes("INVALID_PROVIDER_SELECTION"))
  );
}
