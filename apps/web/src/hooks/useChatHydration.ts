import {
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
} from "react";
import type { Message } from "@ai-sdk/react";
import {
  ChatHydrationService,
  type HydrationStatus,
} from "../services/ChatHydrationService";
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

interface HydrationViewState {
  requestIdentity: string;
  status: HydrationStatus;
  error: string | null;
  settled: boolean;
}

/** Reads transcript by durable session identity, independently of execution scope. */
export function useChatHydration(
  sessionId: string,
  messages: Message[],
  setMessages: (messages: Message[]) => void,
  replayRevision: string | null = null,
  enabled = true,
): UseChatHydrationResult {
  const normalizedSessionId = sessionId.trim();
  const hydrationKey =
    enabled && normalizedSessionId
      ? `${encodeURIComponent(normalizedSessionId)}:${replayRevision ?? "initial"}`
      : null;
  const [requestGeneration, setRequestGeneration] = useState({
    hydrationKey,
    value: 0,
  });
  if (requestGeneration.hydrationKey !== hydrationKey) {
    setRequestGeneration({
      hydrationKey,
      value: requestGeneration.value + 1,
    });
  }
  const [manualRetryRevision, setManualRetryRevision] = useState(0);
  const [viewState, setViewState] = useState<HydrationViewState | null>(null);
  const serviceRef = useRef(new ChatHydrationService());
  const activeRequestIdentityRef = useRef<string | null>(null);
  const settledRequestIdentityRef = useRef<string | null>(null);
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
    scopeKey: hydrationKey,
  });
  const requestIdentity = JSON.stringify([
    hydrationKey,
    requestGeneration.value,
    retrySignal,
    manualRetryRevision,
  ]);
  const retry = useCallback(() => {
    if (!normalizedSessionId) return;
    resetRetry();
    setManualRetryRevision((revision) => revision + 1);
  }, [normalizedSessionId, resetRetry]);

  useLayoutEffect(() => {
    activeRequestIdentityRef.current = requestIdentity;
    return () => {
      if (activeRequestIdentityRef.current === requestIdentity) {
        activeRequestIdentityRef.current = null;
      }
    };
  }, [requestIdentity]);

  useEffect(() => {
    if (!normalizedSessionId || !hydrationKey) return;
    if (settledRequestIdentityRef.current === requestIdentity) return;
    const controller = new AbortController();
    const currentRequestIdentity = requestIdentity;
    activeRequestIdentityRef.current = currentRequestIdentity;
    const requestStartMessages = messagesRef.current;
    settledRequestIdentityRef.current = null;
    logClientEvent("chat/hydration", "requested", {
      sessionId: normalizedSessionId,
      liveMessageCount: requestStartMessages.length,
      retrySignal,
      replayRevision,
    });
    const isCurrent = () =>
      !controller.signal.aborted &&
      activeRequestIdentityRef.current === currentRequestIdentity;

    void serviceRef.current
      .hydrateMessages(normalizedSessionId, controller.signal)
      .then((result) => {
        if (!isCurrent()) return;
        if (result.status === "readable" || result.status === "empty") {
          // Only a complete pinned read may replace the verified transcript.
          setMessages(result.messages);
        } else if (result.status === "partial" && result.messages.length > 0) {
          // Verified pages can extend the transcript, but a partial read may
          // never remove rows established by an earlier complete snapshot.
          setMessages(
            mergePartialTranscript(requestStartMessages, result.messages),
          );
        }
        if (result.status === "cancelled") {
          settledRequestIdentityRef.current = currentRequestIdentity;
          setViewState({
            requestIdentity: currentRequestIdentity,
            status: result.status,
            error: result.error ?? null,
            settled: true,
          });
          return;
        }
        if (result.status === "failed" || result.status === "partial") {
          const retryScheduled = scheduleRetry();
          if (!retryScheduled) {
            settledRequestIdentityRef.current = currentRequestIdentity;
            logClientWarning("chat/hydration", "retry-exhausted", {
              sessionId: normalizedSessionId,
              status: result.status,
            });
          }
        } else {
          settledRequestIdentityRef.current = currentRequestIdentity;
          resetRetry();
        }
        setViewState({
          requestIdentity: currentRequestIdentity,
          status: result.status,
          error: result.error ?? null,
          settled:
            result.status !== "failed" && result.status !== "partial"
              ? true
              : settledRequestIdentityRef.current === currentRequestIdentity,
        });
      })
      .catch((reason: unknown) => {
        if (!isCurrent()) return;
        const message =
          reason instanceof Error ? reason.message : String(reason);
        const retryScheduled = scheduleRetry();
        if (!retryScheduled) {
          settledRequestIdentityRef.current = currentRequestIdentity;
          logClientWarning("chat/hydration", "retry-exhausted", {
            sessionId: normalizedSessionId,
            error: message,
          });
        }
        setViewState({
          requestIdentity: currentRequestIdentity,
          status: "failed",
          error: message,
          settled: !retryScheduled,
        });
      });

    return () => {
      controller.abort();
      if (activeRequestIdentityRef.current === currentRequestIdentity) {
        activeRequestIdentityRef.current = null;
      }
    };
  }, [
    requestIdentity,
    hydrationKey,
    normalizedSessionId,
    replayRevision,
    retrySignal,
    scheduleRetry,
    resetRetry,
    setMessages,
  ]);

  const currentView =
    requestIdentity === viewState?.requestIdentity ? viewState : null;
  return {
    isHydrating: Boolean(hydrationKey) && !currentView,
    // Failures and partial reads are settled UI states. The transcript surface
    // can render recovery guidance instead of blocking forever on a spinner.
    hasHydrated: Boolean(hydrationKey) && Boolean(currentView?.settled),
    status: hydrationKey ? (currentView?.status ?? "loading") : "idle",
    error: currentView?.error ?? null,
    retry,
  };
}

function mergePartialTranscript(
  baseline: Message[],
  verifiedPrefix: Message[],
): Message[] {
  const prefixById = new Map(
    verifiedPrefix.map((message) => [message.id, message]),
  );
  const merged = baseline.map(
    (message) => prefixById.get(message.id) ?? message,
  );
  const baselineIds = new Set(baseline.map((message) => message.id));
  for (const message of verifiedPrefix) {
    if (!baselineIds.has(message.id)) merged.push(message);
  }
  return merged;
}
