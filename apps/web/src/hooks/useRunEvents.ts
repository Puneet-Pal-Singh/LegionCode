import { safeParseRunEvent, type RunEvent } from "@repo/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  runEventsPath,
  runEventsStreamPath,
} from "../lib/platform-endpoints.js";
import {
  dispatchRunSummaryRefresh,
  RUN_SUMMARY_REFRESH_EVENT,
} from "../lib/run-summary-events.js";

interface UseRunEventsResult {
  events: RunEvent[];
}

const EVENT_ERROR_LOG_WINDOW_MS = 30_000;
const RUN_EVENTS_MIN_FETCH_INTERVAL_MS = 800;

export function useRunEvents(
  runId: string,
  shouldStream: boolean = false,
): UseRunEventsResult {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const inFlightRef = useRef(false);
  const lastFetchAtRef = useRef(0);
  const requestIdRef = useRef(0);
  const activeRunIdRef = useRef(runId);
  const missedRefreshRef = useRef(false);
  const lastErrorLogRef = useRef<{
    timestamp: number;
    message: string;
  } | null>(null);

  const fetchEvents = useCallback(
    async (options?: { force?: boolean }) => {
      const currentRunId = runId.trim();
      if (!currentRunId || inFlightRef.current) {
        if (!currentRunId) {
          setEvents([]);
        }
        return;
      }

      const now = Date.now();
      if (
        !options?.force &&
        now - lastFetchAtRef.current < RUN_EVENTS_MIN_FETCH_INTERVAL_MS
      ) {
        return;
      }

      try {
        inFlightRef.current = true;
        lastFetchAtRef.current = now;
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;

        const response = await fetch(runEventsPath(currentRunId));
        if (!response.ok) {
          return;
        }

        const body = await response.text();
        if (
          activeRunIdRef.current !== currentRunId ||
          requestIdRef.current !== requestId
        ) {
          return;
        }

        const parsedEvents = parseNdjsonEvents(body, currentRunId);
        setEvents((current) => mergeRunEvents(current, parsedEvents));
      } catch (error) {
        if (activeRunIdRef.current === currentRunId) {
          logRunEventsWarning(currentRunId, error, lastErrorLogRef);
        }
      } finally {
        if (activeRunIdRef.current === currentRunId) {
          inFlightRef.current = false;
        }
      }
    },
    [runId],
  );

  useEffect(() => {
    activeRunIdRef.current = runId;
    inFlightRef.current = false;
    lastFetchAtRef.current = 0;
    requestIdRef.current += 1;
    lastErrorLogRef.current = null;
    missedRefreshRef.current = false;

    if (!runId) {
      setEvents([]);
      return;
    }

    setEvents([]);
    void fetchEvents({ force: true });
  }, [fetchEvents, runId]);

  useEffect(() => {
    if (!runId || !shouldStream) {
      return;
    }

    const currentRunId = runId.trim();
    const abortController = new AbortController();
    let buffer = "";

    const consumeStream = async () => {
      try {
        const response = await fetch(runEventsStreamPath(currentRunId), {
          signal: abortController.signal,
        });
        if (!response.ok || !response.body) {
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (!abortController.signal.aborted) {
          const next = await reader.read();
          if (next.done) {
            break;
          }

          buffer += decoder.decode(next.value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const event = parseRunEventLine(line, currentRunId);
            if (!event) {
              continue;
            }

            setEvents((current) => mergeRunEvents(current, [event]));
            dispatchRunSummaryRefresh(currentRunId);
          }
        }

        const trailingEvent = parseRunEventLine(buffer, currentRunId);
        if (trailingEvent) {
          setEvents((current) => mergeRunEvents(current, [trailingEvent]));
          dispatchRunSummaryRefresh(currentRunId);
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }
        logRunEventsWarning(currentRunId, error, lastErrorLogRef);
      }
    };

    void consumeStream();

    return () => {
      abortController.abort();
    };
  }, [runId, shouldStream]);

  useEffect(() => {
    if (!runId || shouldStream) {
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
      void fetchEvents({ force: true });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !missedRefreshRef.current) {
        return;
      }
      missedRefreshRef.current = false;
      void fetchEvents({ force: true });
    };

    window.addEventListener(RUN_SUMMARY_REFRESH_EVENT, handleRefreshEvent);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener(RUN_SUMMARY_REFRESH_EVENT, handleRefreshEvent);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchEvents, runId, shouldStream]);

  return { events };
}

function parseNdjsonEvents(body: string, runId: string): RunEvent[] {
  if (!body.trim()) {
    return [];
  }

  const events: RunEvent[] = [];
  for (const line of body.split("\n")) {
    const event = parseRunEventLine(line, runId);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

function parseRunEventLine(line: string, runId: string): RunEvent | null {
  const trimmedLine = line.trim();
  if (!trimmedLine) {
    return null;
  }

  const result = safeParseRunEvent(JSON.parse(trimmedLine) as unknown);
  if (!result.success) {
    console.warn(
      `[run/events] dropped invalid event for runId=${runId}: ${result.error}`,
    );
    return null;
  }

  return result.data;
}

function mergeRunEvents(current: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const byId = new Map<string, RunEvent>();
  for (const event of current) {
    byId.set(event.eventId, event);
  }
  for (const event of incoming) {
    byId.set(event.eventId, event);
  }

  return [...byId.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}

function logRunEventsWarning(
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
    now - previous.timestamp >= EVENT_ERROR_LOG_WINDOW_MS;

  if (!shouldLog) {
    return;
  }

  console.warn(
    `[run/events] failed to fetch events for runId=${runId}: ${message}`,
  );
  lastErrorLogRef.current = {
    timestamp: now,
    message,
  };
}
