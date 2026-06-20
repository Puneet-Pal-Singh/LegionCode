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
const RUN_EVENTS_STREAM_RETRY_DELAY_MS = 500;

export function useRunEvents(
  runId: string,
  shouldStream: boolean = false,
): UseRunEventsResult {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streamRetryVersion, setStreamRetryVersion] = useState(0);
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

        const response = await fetch(runEventsPath(currentRunId), {
          credentials: "include",
        });
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

        const parsedEvents = parseRunEventsBody(body, currentRunId);
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
    return connectRunEventStream({
      runId: currentRunId,
      isActive: () => activeRunIdRef.current === currentRunId,
      onEvent: (event) => {
        setEvents((current) => mergeRunEvents(current, [event]));
        dispatchRunSummaryRefresh(currentRunId);
      },
      onError: (error) =>
        logRunEventsWarning(currentRunId, error, lastErrorLogRef),
      onReconnect: () => setStreamRetryVersion((version) => version + 1),
    });
  }, [runId, shouldStream, streamRetryVersion]);

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

interface RunEventStreamConnection {
  runId: string;
  isActive: () => boolean;
  onEvent: (event: RunEvent) => void;
  onError: (error: unknown) => void;
  onReconnect: () => void;
}

function connectRunEventStream(input: RunEventStreamConnection): () => void {
  const abortController = new AbortController();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleReconnect = () => {
    if (abortController.signal.aborted || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (input.isActive()) input.onReconnect();
    }, RUN_EVENTS_STREAM_RETRY_DELAY_MS);
  };
  void consumeRunEventStream(input.runId, abortController.signal, input.onEvent)
    .catch((error) => {
      if (!abortController.signal.aborted) input.onError(error);
    })
    .finally(scheduleReconnect);
  return () => {
    abortController.abort();
    if (retryTimer) clearTimeout(retryTimer);
  };
}

async function consumeRunEventStream(
  runId: string,
  signal: AbortSignal,
  onEvent: (event: RunEvent) => void,
): Promise<void> {
  const response = await fetch(runEventsStreamPath(runId), {
    signal,
    credentials: "include",
  });
  if (!response.ok || !response.body) return;
  await readRunEventStream(response.body.getReader(), runId, signal, onEvent);
}

async function readRunEventStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  runId: string,
  signal: AbortSignal,
  onEvent: (event: RunEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach((line) => emitRunEventLine(line, runId, onEvent));
  }
  emitRunEventLine(buffer, runId, onEvent);
}

function emitRunEventLine(
  line: string,
  runId: string,
  onEvent: (event: RunEvent) => void,
): void {
  const event = parseRunEventLine(line, runId);
  if (event) onEvent(event);
}

function parseRunEventsBody(body: string, runId: string): RunEvent[] {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return [];
  }

  const parsedJson = tryParseJson(trimmedBody);
  if (parsedJson.ok) {
    return parseRunEventsPayload(parsedJson.value, runId);
  }

  return parseNdjsonEvents(trimmedBody, runId);
}

function parseRunEventsPayload(payload: unknown, runId: string): RunEvent[] {
  if (Array.isArray(payload)) {
    return payload
      .map((event) => parseRunEventPayload(event, runId))
      .filter((event): event is RunEvent => event !== null);
  }

  const event = parseRunEventPayload(payload, runId);
  return event ? [event] : [];
}

function parseNdjsonEvents(body: string, runId: string): RunEvent[] {
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

  const parsedJson = tryParseJson(trimmedLine);
  if (!parsedJson.ok) {
    console.warn(
      `[run/events] dropped invalid JSON event for runId=${runId}: ${parsedJson.error.message}`,
    );
    return null;
  }

  return parseRunEventPayload(parsedJson.value, runId);
}

function parseRunEventPayload(
  payload: unknown,
  runId: string,
): RunEvent | null {
  const result = safeParseRunEvent(payload);
  if (!result.success) {
    console.warn(
      `[run/events] dropped invalid event for runId=${runId}: ${result.error}`,
    );
    return null;
  }

  if (result.data.runId !== runId) {
    console.warn(
      `[run/events] dropped event for mismatched runId=${result.data.runId}; active runId=${runId}`,
    );
    return null;
  }

  return result.data;
}

function tryParseJson(
  value: string,
): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
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
