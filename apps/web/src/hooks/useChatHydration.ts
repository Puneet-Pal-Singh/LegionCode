import { useRef, useEffect, useState } from "react";
import type { Message } from "@ai-sdk/react";
import { ChatHydrationService } from "../services/ChatHydrationService";

interface UseChatHydrationResult {
  isHydrating: boolean;
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
  const hasHydratedRef = useRef(false);
  const hydrationServiceRef = useRef(new ChatHydrationService());

  // Reset hydration flag when runId changes
  useEffect(() => {
    hasHydratedRef.current = false;
  }, [runId]);

  // Perform hydration
  useEffect(() => {
    if (hasHydratedRef.current) return;
    if (messagesLength > 0) return;

    async function hydrate() {
      setIsHydrating(true);
      const result = await hydrationServiceRef.current.hydrateMessages(
        sessionId,
        runId,
      );

      if (result.error) {
        console.error("🧬 [LegionCode] Hydration failed:", result.error);
      } else if (result.messages.length > 0) {
        setMessages(result.messages);
      }

      setIsHydrating(false);
      hasHydratedRef.current = true;
    }

    hydrate();
  }, [sessionId, runId, messagesLength, setMessages]);

  return { isHydrating };
}
