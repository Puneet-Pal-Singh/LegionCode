import { useRef, useEffect, useState } from "react";
import type { Message } from "@ai-sdk/react";
import { ChatHydrationService } from "../services/ChatHydrationService";
import { useRetry } from "./useRetry";

interface UseChatHydrationResult {
  isHydrating: boolean;
  hasHydrated: boolean;
}

const MAX_HYDRATION_ATTEMPTS = 3;
const HYDRATION_RETRY_DELAY_MS = 300;

/**
 * useChatHydration
 * Handles message hydration from server
 * Single Responsibility: Only manage hydration lifecycle
 */
export function useChatHydration(
  sessionId: string,
  runId: string,
  _messagesLength: number,
  setMessages: (messages: Message[]) => void,
): UseChatHydrationResult {
  const [isHydrating, setIsHydrating] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const hasHydratedRef = useRef(false);
  const hydrationServiceRef = useRef(new ChatHydrationService());
  const scopeKey = `${sessionId}:${runId}`;
  const activeScopeKeyRef = useRef(scopeKey);

  const { signal: retrySignal, schedule: scheduleRetry, reset: resetRetry } = useRetry({
    delayMs: HYDRATION_RETRY_DELAY_MS,
    maxAttempts: MAX_HYDRATION_ATTEMPTS,
    scopeKey,
  });

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    hasHydratedRef.current = false;
    setHasHydrated(false);
    setIsHydrating(false);
  }, [scopeKey]);

  // Perform hydration
  useEffect(() => {
    if (hasHydratedRef.current) return;

    let cancelled = false;
    const requestScopeKey = scopeKey;
    const isCurrentScope = () =>
      !cancelled && activeScopeKeyRef.current === requestScopeKey;
    const loadingTimer = window.setTimeout(() => {
      if (isCurrentScope()) {
        setIsHydrating(true);
      }
    }, 150);

    const retryOnError = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("🧬 [LegionCode] Hydration failed:", message);
      if (isCurrentScope()) {
        scheduleRetry();
      }
    };

    async function hydrate() {
      try {
        const result = await hydrationServiceRef.current.hydrateMessages(
          sessionId,
          runId,
        );

        if (!isCurrentScope()) {
          return;
        }

        if (result.error) {
          retryOnError(result.error);
          return;
        }

        setMessages(result.messages);

        hasHydratedRef.current = true;
        resetRetry();
        setHasHydrated(true);
      } catch (error) {
        if (isCurrentScope()) {
          retryOnError(error);
        }
      } finally {
        window.clearTimeout(loadingTimer);
        if (isCurrentScope()) {
          setIsHydrating(false);
        }
      }
    }

    void hydrate();

    return () => {
      cancelled = true;
      window.clearTimeout(loadingTimer);
    };
  }, [
    resetRetry,
    retrySignal,
    runId,
    scheduleRetry,
    scopeKey,
    sessionId,
    setMessages,
  ]);

  return { isHydrating, hasHydrated };
}
