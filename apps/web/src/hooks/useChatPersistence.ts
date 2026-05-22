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
  hasHydrated: boolean;
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
  hasHydrated,
  isModelConfigReady,
  append,
}: UseChatPersistenceProps): void {
  const persistenceService = useMemo(() => new ChatPersistenceService(), []);
  const attemptedRestoreKeyRef = useRef<string | null>(null);
  const scopeKey = `${sessionId}:${runId}`;
  const activeScopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    attemptedRestoreKeyRef.current = null;
  }, [scopeKey]);

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
    if (!hasHydrated) {
      return;
    }
    if (!persistenceService.shouldRestorePendingQuery(messagesLength, isLoading)) {
      return;
    }
    const restoreKey = `${sessionId}:${runId}:${pendingQuery}`;
    if (attemptedRestoreKeyRef.current === restoreKey) {
      return;
    }
    attemptedRestoreKeyRef.current = restoreKey;
    let cancelled = false;
    const requestScopeKey = scopeKey;
    const isCurrentScope = () =>
      !cancelled && activeScopeKeyRef.current === requestScopeKey;

    const restorePendingQuery = async (): Promise<void> => {
      try {
        await append({ role: "user", content: pendingQuery });
        if (!isCurrentScope()) {
          return;
        }
        persistenceService.clearPendingQuery(sessionId);
        attemptedRestoreKeyRef.current = null;
      } catch (error) {
        if (!isCurrentScope()) {
          return;
        }
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

    return () => {
      cancelled = true;
    };
  }, [
    sessionId,
    runId,
    scopeKey,
    messagesLength,
    isLoading,
    hasHydrated,
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
