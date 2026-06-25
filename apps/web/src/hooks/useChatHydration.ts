import { useRef, useEffect, useState } from "react";
import type { Message } from "@ai-sdk/react";
import { ChatHydrationService } from "../services/ChatHydrationService";
import { logClientEvent, logClientWarning } from "../lib/client-logger.js";
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
  messages: Message[],
  setMessages: (messages: Message[]) => void,
): UseChatHydrationResult {
  const [isHydrating, setIsHydrating] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const hasHydratedRef = useRef(false);
  const hydrationServiceRef = useRef(new ChatHydrationService());
  const scopeKey = `${sessionId}:${runId}`;
  const activeScopeKeyRef = useRef(scopeKey);
  const messagesRef = useRef(messages);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const {
    signal: retrySignal,
    schedule: scheduleRetry,
    reset: resetRetry,
  } = useRetry({
    delayMs: HYDRATION_RETRY_DELAY_MS,
    maxAttempts: MAX_HYDRATION_ATTEMPTS,
    scopeKey,
  });

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    hasHydratedRef.current = false;
    setHasHydrated(false);
    setIsHydrating(false);
    logClientEvent("chat/hydration", "scope-reset", {
      runId,
      liveMessageCount: messagesRef.current.length,
    });
  }, [runId, scopeKey]);

  // Perform hydration
  useEffect(() => {
    if (hasHydratedRef.current) return;

    let cancelled = false;
    const requestScopeKey = scopeKey;
    const requestStartMessageIds = readMessageIds(messagesRef.current);
    logClientEvent("chat/hydration", "requested", {
      runId,
      liveMessageCount: requestStartMessageIds.length,
      retrySignal,
    });
    const isCurrentScope = () =>
      !cancelled && activeScopeKeyRef.current === requestScopeKey;
    const loadingTimer = window.setTimeout(() => {
      if (isCurrentScope()) {
        setIsHydrating(true);
      }
    }, 150);

    const retryOnError = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      logClientWarning("chat/hydration", "failed", {
        runId,
        error: message,
        retrySignal,
      });
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
          logClientEvent("chat/hydration", "discarded", {
            runId,
            reason: "scope-changed",
            hydratedMessageCount: result.messages.length,
          });
          return;
        }

        if (result.error) {
          retryOnError(result.error);
          return;
        }

        const replaceLiveMessages = haveSameMessageIds(
          messagesRef.current,
          requestStartMessageIds,
        );
        const nextMessages = replaceLiveMessages
          ? result.messages
          : mergeHydratedAndLiveMessages(result.messages, messagesRef.current);
        logClientEvent("chat/hydration", "completed", {
          runId,
          hydratedMessageCount: result.messages.length,
          liveMessageCount: messagesRef.current.length,
          finalMessageCount: nextMessages.length,
          mergeMode: replaceLiveMessages ? "replace" : "preserve-live",
        });
        setMessages(nextMessages);

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

function readMessageIds(messages: Message[]): string[] {
  return messages.map((message) => message.id);
}

function haveSameMessageIds(messages: Message[], ids: string[]): boolean {
  return (
    messages.length === ids.length &&
    messages.every((message, index) => message.id === ids[index])
  );
}

function mergeHydratedAndLiveMessages(
  hydrated: Message[],
  live: Message[],
): Message[] {
  const liveById = new Map(live.map((message) => [message.id, message]));
  const merged = hydrated.map((message) => liveById.get(message.id) ?? message);
  const hydratedIds = new Set(hydrated.map((message) => message.id));
  return [...merged, ...live.filter((message) => !hydratedIds.has(message.id))];
}
