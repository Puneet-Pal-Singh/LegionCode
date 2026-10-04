import { useRef, useEffect, useState, useCallback } from "react";
import type { Message } from "@ai-sdk/react";
import { ChatHydrationService, type HydrationStatus } from "../services/ChatHydrationService";
import { logClientEvent, logClientWarning } from "../lib/client-logger.js";
import { useRetry } from "./useRetry";

interface UseChatHydrationResult {
  isHydrating: boolean;
  hasHydrated: boolean;
  status: HydrationStatus | "loading" | "idle";
  error: string | null;
  retry: () => void;
}

const MAX_HYDRATION_ATTEMPTS = 3;
const HYDRATION_RETRY_DELAY_MS = 300;

/** Reads transcript by durable session identity, independently of execution scope. */
export function useChatHydration(
  sessionId: string,
  messages: Message[],
  setMessages: (messages: Message[]) => void,
  replayRevision: string | null = null,
  enabled = true,
): UseChatHydrationResult {
  const normalizedSessionId = sessionId.trim();
  const hydrationKey = enabled && normalizedSessionId
    ? `${encodeURIComponent(normalizedSessionId)}:${replayRevision ?? "initial"}`
    : null;
  const [isHydrating, setIsHydrating] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<HydrationStatus | "loading" | "idle">("idle");
  const [error, setError] = useState<string | null>(null);
  const [manualRetryRevision, setManualRetryRevision] = useState(0);
  const serviceRef = useRef(new ChatHydrationService());
  const activeKeyRef = useRef(hydrationKey);
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const { signal: retrySignal, schedule: scheduleRetry, reset: resetRetry } = useRetry({
    delayMs: HYDRATION_RETRY_DELAY_MS,
    maxAttempts: MAX_HYDRATION_ATTEMPTS,
    scopeKey: hydrationKey,
  });
  const retry = useCallback(() => {
    if (!normalizedSessionId) return;
    resetRetry();
    setLoadedKey(null);
    setStatus("loading");
    setError(null);
    setManualRetryRevision((revision) => revision + 1);
  }, [normalizedSessionId, resetRetry]);

  useEffect(() => {
    activeKeyRef.current = hydrationKey;
    setLoadedKey(null);
    setStatus(hydrationKey ? "loading" : "idle");
    setError(null);
    setIsHydrating(false);
  }, [hydrationKey]);

  useEffect(() => {
    if (!normalizedSessionId || !hydrationKey || loadedKey === hydrationKey) return;
    const controller = new AbortController();
    const requestKey = hydrationKey;
    const requestStartMessages = messagesRef.current;
    setStatus("loading");
    setIsHydrating(true);
    setError(null);
    logClientEvent("chat/hydration", "requested", {
      sessionId: normalizedSessionId,
      liveMessageCount: requestStartMessages.length,
      retrySignal,
      replayRevision,
    });
    const isCurrent = () => !controller.signal.aborted && activeKeyRef.current === requestKey;

    void serviceRef.current.hydrateMessages(normalizedSessionId, controller.signal)
      .then((result) => {
        if (!isCurrent() || result.status === "cancelled") return;
        if (result.messages.length > 0 || result.status === "empty") {
          // Treat the request-start list as a baseline. Canonical history
          // replaces unchanged baseline items; only optimistic items created
          // or edited while the request was in flight are overlaid on it.
          setMessages(mergeHydratedAndLiveMessages(
            result.messages,
            requestStartMessages,
            messagesRef.current,
          ));
        }
        setStatus(result.status);
        setError(result.error ?? null);
        if (result.status === "failed" || result.status === "partial") {
          if (!scheduleRetry()) {
            setLoadedKey(requestKey);
            logClientWarning("chat/hydration", "retry-exhausted", {
              sessionId: normalizedSessionId,
              status: result.status,
            });
          }
        } else {
          setLoadedKey(requestKey);
          resetRetry();
        }
      })
      .catch((reason: unknown) => {
        if (!isCurrent()) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setStatus("failed");
        setError(message);
        if (!scheduleRetry()) {
          setLoadedKey(requestKey);
          logClientWarning("chat/hydration", "retry-exhausted", {
            sessionId: normalizedSessionId,
            error: message,
          });
        }
      })
      .finally(() => {
        if (isCurrent()) setIsHydrating(false);
      });

    return () => controller.abort();
  }, [
    hydrationKey,
    loadedKey,
    normalizedSessionId,
    replayRevision,
    retrySignal,
    manualRetryRevision,
    scheduleRetry,
    resetRetry,
    setMessages,
  ]);

  return {
    isHydrating,
    // Failures and partial reads are settled UI states. The transcript surface
    // can render recovery guidance instead of blocking forever on a spinner.
    hasHydrated: Boolean(hydrationKey) && loadedKey === hydrationKey,
    status,
    error,
    retry,
  };
}

function mergeHydratedAndLiveMessages(
  hydrated: Message[],
  requestStart: Message[],
  live: Message[],
): Message[] {
  const startById = new Map(requestStart.map((message) => [message.id, message]));
  const hydratedIds = new Set(hydrated.map((message) => message.id));
  const changedDuringRequest = live.filter((message) => {
    const atStart = startById.get(message.id);
    return !atStart || !sameMessage(atStart, message);
  });
  const merged = hydrated.map((message) => {
    const changed = changedDuringRequest.find((candidate) => candidate.id === message.id);
    return changed ?? message;
  });
  return [
    ...merged,
    ...changedDuringRequest.filter((message) => !hydratedIds.has(message.id)),
  ];
}

function sameMessage(left: Message, right: Message): boolean {
  // Message payloads are JSON-shaped. Comparing the full payload (rather than
  // IDs) detects streamed edits to an existing assistant message.
  return JSON.stringify(left) === JSON.stringify(right);
}
