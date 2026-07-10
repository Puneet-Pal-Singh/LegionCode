import {
  parseActivityFeedSnapshot,
  type ActivityFeedSnapshot,
} from "@repo/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { runActivityPath } from "../lib/platform-endpoints.js";
import { RUN_SUMMARY_REFRESH_EVENT } from "../lib/run-summary-events.js";
import { logClientEvent, logClientWarning } from "../lib/client-logger.js";

interface UseRunActivityFeedResult {
  feed: ActivityFeedSnapshot | null;
}

const ACTIVITY_FEED_ERROR_LOG_WINDOW_MS = 30_000;
const ACTIVITY_FEED_MIN_FETCH_INTERVAL_MS = 800;
const ACTIVITY_FEED_POLL_INTERVAL_MS = 1_000;
const ACTIVITY_FEED_RETRY_DELAY_MS = 5_000;
const AUTH_BLOCKING_STATUS_CODES = new Set([401, 403]);

export function useRunActivityFeed(
  runId: string,
  shouldPoll = false,
): UseRunActivityFeedResult {
  const [feed, setFeed] = useState<ActivityFeedSnapshot | null>(null);
  const activeRunIdRef = useRef(runId);
  const inFlightRef = useRef(false);
  const inFlightRunIdRef = useRef<string | null>(null);
  const lastFetchAtRef = useRef(0);
  const retryAfterRef = useRef(0);
  const missedRefreshRef = useRef(false);
  const prevShouldPollRef = useRef(shouldPoll);
  const lastErrorLogRef = useRef<{
    timestamp: number;
    message: string;
  } | null>(null);
  const lastLoggedSnapshotRef = useRef("");

  const fetchFeed = useCallback(
    async (options?: { force?: boolean }) => {
      const currentRunId = runId.trim();
      if (!currentRunId) {
        setFeed(null);
        return;
      }
      if (inFlightRef.current) {
        logClientEvent("run/activity", "fetch-skipped", {
          runId: currentRunId,
          reason: "in-flight",
          inFlightRunId: inFlightRunIdRef.current,
          force: Boolean(options?.force),
        });
        return;
      }
      const now = Date.now();
      if (now < retryAfterRef.current) {
        logClientEvent("run/activity", "fetch-skipped", {
          runId: currentRunId,
          reason: "retry-delay",
          retryInMs: retryAfterRef.current - now,
          force: Boolean(options?.force),
        });
        return;
      }
      if (
        !options?.force &&
        now - lastFetchAtRef.current < ACTIVITY_FEED_MIN_FETCH_INTERVAL_MS
      ) {
        logClientEvent("run/activity", "fetch-skipped", {
          runId: currentRunId,
          reason: "throttled",
          sinceLastFetchMs: now - lastFetchAtRef.current,
          force: false,
        });
        return;
      }

      try {
        inFlightRef.current = true;
        inFlightRunIdRef.current = currentRunId;
        lastFetchAtRef.current = now;
        logClientEvent("run/activity", "fetch-started", {
          runId: currentRunId,
          force: Boolean(options?.force),
          shouldPoll,
        });
        const response = await fetch(runActivityPath(currentRunId), {
          credentials: "include",
        });
        if (activeRunIdRef.current !== currentRunId) {
          logClientEvent("run/activity", "fetch-discarded", {
            runId: currentRunId,
            activeRunId: activeRunIdRef.current,
            reason: "run-changed-after-response",
            status: response.status,
          });
          return;
        }
        if (!response.ok) {
          if (response.status === 404) {
            logClientEvent("run/activity", "not-found", {
              runId: currentRunId,
              status: response.status,
            });
            return;
          }
          if (AUTH_BLOCKING_STATUS_CODES.has(response.status)) {
            logClientWarning("run/activity", "auth-failed", {
              runId: currentRunId,
              status: response.status,
              retryDelayMs: ACTIVITY_FEED_RETRY_DELAY_MS,
            });
          }
          retryAfterRef.current = Date.now() + ACTIVITY_FEED_RETRY_DELAY_MS;
          logActivityFeedWarning(
            currentRunId,
            new Error(`HTTP ${response.status}: ${response.statusText}`),
            lastErrorLogRef,
          );
          return;
        }

        const payload = parseActivityFeedSnapshot(await response.json());
        if (activeRunIdRef.current !== currentRunId) {
          logClientEvent("run/activity", "payload-discarded", {
            runId: currentRunId,
            activeRunId: activeRunIdRef.current,
            reason: "run-changed-after-payload",
            payloadStatus: payload.status,
            itemCount: payload.items.length,
          });
          return;
        }
        if (payload.runId !== currentRunId) {
          logClientWarning("run/activity", "payload-run-mismatch", {
            runId: currentRunId,
            payloadRunId: payload.runId,
            status: payload.status,
            itemCount: payload.items.length,
          });
          return;
        }
        retryAfterRef.current = 0;
        const snapshotSignature = `${payload.status}:${payload.items.length}`;
        if (lastLoggedSnapshotRef.current !== snapshotSignature) {
          lastLoggedSnapshotRef.current = snapshotSignature;
          logClientEvent("run/activity", "updated", {
            runId: currentRunId,
            status: payload.status,
            itemCount: payload.items.length,
          });
        }
        setFeed(payload);
      } catch (error) {
        if (activeRunIdRef.current === currentRunId) {
          retryAfterRef.current = Date.now() + ACTIVITY_FEED_RETRY_DELAY_MS;
          logActivityFeedWarning(currentRunId, error, lastErrorLogRef);
        }
      } finally {
        if (inFlightRunIdRef.current === currentRunId) {
          inFlightRef.current = false;
          inFlightRunIdRef.current = null;
        }
      }
    },
    [runId, shouldPoll],
  );

  useEffect(() => {
    activeRunIdRef.current = runId;
    inFlightRef.current = false;
    inFlightRunIdRef.current = null;
    lastFetchAtRef.current = 0;
    retryAfterRef.current = 0;
    missedRefreshRef.current = false;
    lastErrorLogRef.current = null;
    lastLoggedSnapshotRef.current = "";
    setFeed(null);

    if (!runId) {
      return;
    }

    void fetchFeed({ force: true });
  }, [fetchFeed, runId]);

  useEffect(() => {
    if (!runId || !shouldPoll) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void fetchFeed({ force: true });
    }, ACTIVITY_FEED_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchFeed, runId, shouldPoll]);

  useEffect(() => {
    if (!runId) {
      return;
    }

    const handleRefreshEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ runId?: string }>;
      if (customEvent.detail?.runId !== runId) {
        return;
      }
      if (document.visibilityState !== "visible") {
        missedRefreshRef.current = true;
        return;
      }
      void fetchFeed({ force: true });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !missedRefreshRef.current) {
        return;
      }
      missedRefreshRef.current = false;
      void fetchFeed({ force: true });
    };

    window.addEventListener(RUN_SUMMARY_REFRESH_EVENT, handleRefreshEvent);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener(RUN_SUMMARY_REFRESH_EVENT, handleRefreshEvent);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchFeed, runId]);

  useEffect(() => {
    const wasPolling = prevShouldPollRef.current;
    prevShouldPollRef.current = shouldPoll;

    if (wasPolling && !shouldPoll) {
      void fetchFeed({ force: true });
    }
  }, [fetchFeed, shouldPoll]);

  return { feed: feed?.runId === runId.trim() ? feed : null };
}

function logActivityFeedWarning(
  runId: string,
  error: unknown,
  lastErrorLogRef: MutableRefObject<{
    timestamp: number;
    message: string;
  } | null>,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  const previous = lastErrorLogRef.current;
  const shouldLog =
    !previous ||
    previous.message !== message ||
    now - previous.timestamp >= ACTIVITY_FEED_ERROR_LOG_WINDOW_MS;

  if (!shouldLog) {
    return;
  }

  logClientWarning("run/activity", "fetch-failed", {
    runId,
    error: message,
  });
  lastErrorLogRef.current = {
    timestamp: now,
    message,
  };
}
