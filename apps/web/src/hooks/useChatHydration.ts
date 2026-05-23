import { useRef, useEffect, useState } from "react";
import type { Message } from "@ai-sdk/react";
import { ChatHydrationService } from "../services/ChatHydrationService";

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
  messagesLength: number,
  setMessages: (messages: Message[]) => void,
): UseChatHydrationResult {
  const [isHydrating, setIsHydrating] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [retrySignal, setRetrySignal] = useState(0);
  const hasHydratedRef = useRef(false);
  const attemptCountRef = useRef(0);
  const hydrationServiceRef = useRef(new ChatHydrationService());
  const scopeKey = `${sessionId}:${runId}`;
  const activeScopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    hasHydratedRef.current = false;
    attemptCountRef.current = 0;
    setHasHydrated(false);
    setIsHydrating(false);
  }, [scopeKey]);

  // Perform hydration
  useEffect(() => {
    if (hasHydratedRef.current) return;
    if (messagesLength > 0) {
      hasHydratedRef.current = true;
      attemptCountRef.current = 0;
      setHasHydrated(true);
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    const requestScopeKey = scopeKey;
    const isCurrentScope = () =>
      !cancelled && activeScopeKeyRef.current === requestScopeKey;
    const loadingTimer = window.setTimeout(() => {
      if (isCurrentScope()) {
        setIsHydrating(true);
      }
    }, 150);

    const scheduleRetry = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("🧬 [LegionCode] Hydration failed:", message);
      if (attemptCountRef.current >= MAX_HYDRATION_ATTEMPTS) {
        return;
      }
      retryTimer = window.setTimeout(() => {
        if (isCurrentScope()) {
          setRetrySignal((current) => current + 1);
        }
      }, HYDRATION_RETRY_DELAY_MS);
    };

    async function hydrate() {
      attemptCountRef.current += 1;
      try {
        const result = await hydrationServiceRef.current.hydrateMessages(
          sessionId,
          runId,
        );

        if (!isCurrentScope()) {
          return;
        }

        if (result.error) {
          scheduleRetry(result.error);
          return;
        }

        if (result.messages.length > 0) {
          setMessages(result.messages);
        }

        hasHydratedRef.current = true;
        attemptCountRef.current = 0;
        setHasHydrated(true);
      } catch (error) {
        if (isCurrentScope()) {
          scheduleRetry(error);
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
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [sessionId, runId, scopeKey, messagesLength, retrySignal, setMessages]);

  return { isHydrating, hasHydrated };
}
