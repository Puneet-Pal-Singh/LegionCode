import {
  parseActivityFeedSnapshot,
  type ActivityFeedSnapshot,
} from "@repo/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { runActivityPath } from "../lib/platform-endpoints.js";
import { RUN_SUMMARY_REFRESH_EVENT } from "../lib/run-summary-events.js";

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
  const authBlockedRunIdRef = useRef<string | null>(null);
  const missedRefreshRef = useRef(false);
  const prevShouldPollRef = useRef(shouldPoll);
  const lastErrorLogRef = useRef<{
    timestamp: number;
    message: string;
  } | null>(null);

  const fetchFeed = useCallback(
    async (options?: { force?: boolean }) => {
      const currentRunId = runId.trim();
      if (!currentRunId) {
        setFeed(null);
        return;
      }
      if (inFlightRef.current) {
        return;
      }
      const now = Date.now();
      if (authBlockedRunIdRef.current === currentRunId) {
        return;
      }
      if (now < retryAfterRef.current) {
        return;
      }
      if (
        !options?.force &&
        now - lastFetchAtRef.current < ACTIVITY_FEED_MIN_FETCH_INTERVAL_MS
      ) {
        return;
      }

      try {
        inFlightRef.current = true;
        inFlightRunIdRef.current = currentRunId;
        lastFetchAtRef.current = now;
        const response = await fetch(runActivityPath(currentRunId), {
          credentials: "include",
        });
        if (activeRunIdRef.current !== currentRunId) {
          return;
        }
        if (!response.ok) {
          if (AUTH_BLOCKING_STATUS_CODES.has(response.status)) {
            authBlockedRunIdRef.current = currentRunId;
          } else {
            retryAfterRef.current = Date.now() + ACTIVITY_FEED_RETRY_DELAY_MS;
          }
          logActivityFeedWarning(
            currentRunId,
            new Error(`HTTP ${response.status}: ${response.statusText}`),
            lastErrorLogRef,
          );
          return;
        }

        const payload = parseActivityFeedSnapshot(await response.json());
        if (activeRunIdRef.current !== currentRunId) {
          return;
        }
        if (payload.runId !== currentRunId) {
          return;
        }
        authBlockedRunIdRef.current = null;
        retryAfterRef.current = 0;
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
    [runId],
  );

  useEffect(() => {
    activeRunIdRef.current = runId;
    inFlightRef.current = false;
    inFlightRunIdRef.current = null;
    lastFetchAtRef.current = 0;
    retryAfterRef.current = 0;
    authBlockedRunIdRef.current = null;
    missedRefreshRef.current = false;
    lastErrorLogRef.current = null;
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

  console.warn(
    `[run/activity-feed] failed to fetch activity feed for runId=${runId}: ${message}`,
  );
  lastErrorLogRef.current = {
    timestamp: now,
    message,
  };
}
