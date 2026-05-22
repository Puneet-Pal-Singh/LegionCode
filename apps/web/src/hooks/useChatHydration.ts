import { useRef, useEffect, useState } from "react";
import type { Message } from "@ai-sdk/react";
import { ChatHydrationService } from "../services/ChatHydrationService";

interface UseChatHydrationResult {
  isHydrating: boolean;
  hasHydrated: boolean;
}

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
  const hasHydratedRef = useRef(false);
  const hydrationServiceRef = useRef(new ChatHydrationService());
  const scopeKey = `${sessionId}:${runId}`;
  const activeScopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    hasHydratedRef.current = false;
    setHasHydrated(false);
    setIsHydrating(false);
  }, [scopeKey]);

  // Perform hydration
  useEffect(() => {
    if (hasHydratedRef.current) return;
    if (messagesLength > 0) {
      hasHydratedRef.current = true;
      setHasHydrated(true);
      return;
    }

    let cancelled = false;
    const requestScopeKey = scopeKey;
    const isCurrentScope = () =>
      !cancelled && activeScopeKeyRef.current === requestScopeKey;
    const loadingTimer = window.setTimeout(() => {
      if (isCurrentScope()) {
        setIsHydrating(true);
      }
    }, 150);

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
          console.error("🧬 [LegionCode] Hydration failed:", result.error);
        } else if (result.messages.length > 0) {
          setMessages(result.messages);
        }
      } catch (error) {
        if (isCurrentScope()) {
          console.error("🧬 [LegionCode] Hydration failed:", error);
        }
      } finally {
        window.clearTimeout(loadingTimer);
        if (isCurrentScope()) {
          setIsHydrating(false);
          hasHydratedRef.current = true;
          setHasHydrated(true);
        }
      }
    }

    void hydrate();

    return () => {
      cancelled = true;
      window.clearTimeout(loadingTimer);
    };
  }, [sessionId, runId, scopeKey, messagesLength, setMessages]);

  return { isHydrating, hasHydrated };
}
