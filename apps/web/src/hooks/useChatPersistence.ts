import { useEffect, useMemo, useRef } from "react";
import type { Message } from "@ai-sdk/react";
import { ChatPersistenceService } from "../services/ChatPersistenceService";
import { ProviderApiError } from "../services/api/providerClient.js";
import { useRetry } from "./useRetry";

const MAX_PENDING_RESTORE_ATTEMPTS = 3;
const PENDING_RESTORE_RETRY_DELAY_MS = 500;

interface UseChatPersistenceProps {
  sessionId: string;
  runId: string;
  messages: Message[];
  messagesLength: number;
  isLoading: boolean;
  isModelConfigReady: boolean;
  allowPendingQueryRestore: boolean;
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
  allowPendingQueryRestore,
  append,
}: UseChatPersistenceProps): void {
  const persistenceService = useMemo(() => new ChatPersistenceService(), []);
  const attemptedRestoreKeyRef = useRef<string | null>(null);
  const claimedPendingQueryRef = useRef<string | null>(null);
  const scopeKey = `${sessionId}:${runId}`;
  const activeScopeKeyRef = useRef(scopeKey);

  const { signal: restoreRetrySignal, schedule: scheduleRestoreRetry, reset: resetRestoreRetry } = useRetry({
    delayMs: PENDING_RESTORE_RETRY_DELAY_MS,
    maxAttempts: MAX_PENDING_RESTORE_ATTEMPTS,
    scopeKey,
  });

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    attemptedRestoreKeyRef.current = null;
    claimedPendingQueryRef.current = null;
    resetRestoreRetry();
  }, [scopeKey, resetRestoreRetry]);

  // Sync messages to global store
  useEffect(() => {
    persistenceService.syncToStore(runId, messages);
  }, [messages, runId, persistenceService]);

  useEffect(() => {
    if (messagesLength === 0) {
      return;
    }
    persistenceService.clearPendingQuery(sessionId);
    claimedPendingQueryRef.current = null;
    attemptedRestoreKeyRef.current = null;
    resetRestoreRetry();
  }, [messagesLength, persistenceService, resetRestoreRetry, sessionId]);

  // Restore pending query from localStorage
  useEffect(() => {
    const storedPendingQuery = persistenceService.getPendingQuery(sessionId);
    const pendingQuery = claimedPendingQueryRef.current ?? storedPendingQuery;
    if (!pendingQuery) {
      attemptedRestoreKeyRef.current = null;
      return;
    }
    if (!allowPendingQueryRestore) {
      persistenceService.clearPendingQuery(sessionId);
      claimedPendingQueryRef.current = null;
      attemptedRestoreKeyRef.current = null;
      resetRestoreRetry();
      return;
    }
    if (!isModelConfigReady) {
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
    if (storedPendingQuery === pendingQuery) {
      claimedPendingQueryRef.current = pendingQuery;
      persistenceService.clearPendingQuery(sessionId);
    }
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
        claimedPendingQueryRef.current = null;
        attemptedRestoreKeyRef.current = null;
        resetRestoreRetry();
      } catch (error) {
        if (!isCurrentScope()) {
          return;
        }
        if (shouldDropPendingQuery(error)) {
          claimedPendingQueryRef.current = null;
          attemptedRestoreKeyRef.current = null;
          resetRestoreRetry();
          console.warn(
            "[useChatPersistence] Dropping stale pending query after non-retryable restore error",
            error,
          );
          return;
        }
        console.error("[useChatPersistence] Failed to restore pending query", error);
        attemptedRestoreKeyRef.current = null;
        scheduleRestoreRetry();
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
    isModelConfigReady,
    allowPendingQueryRestore,
    append,
    persistenceService,
    restoreRetrySignal,
    scheduleRestoreRetry,
    resetRestoreRetry,
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
