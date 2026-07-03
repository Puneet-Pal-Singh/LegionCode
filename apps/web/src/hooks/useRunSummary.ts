import { useCallback, useEffect, useRef, useState } from "react";
import { getBrainHttpBase } from "../lib/platform-endpoints.js";
import {
  isApprovalRequiredRunStatus,
  isTerminalRunStatus,
} from "../lib/run-status.js";
import {
  RUN_SUMMARY_REFRESH_EVENT,
  type RunSummaryRefreshDetail,
} from "../lib/run-summary-events.js";
import type {
  ApprovalRequest,
  PermissionRuntimeLabel,
  WorkflowIntentResolverInput,
} from "@repo/shared-types";

interface RunPlanArtifactTask {
  id: string;
  type: string;
  description: string;
  dependsOn: string[];
  expectedOutput?: string;
  executionKind: "read" | "mutating";
}

interface RunPlanArtifact {
  id: string;
  createdAt: string;
  summary: string;
  estimatedSteps: number;
  reasoning?: string;
  tasks: RunPlanArtifactTask[];
  handoff: {
    targetMode: "build";
    prompt: string;
    summary: string;
  };
}

interface RunSummary {
  runId: string;
  status: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks?: number;
  pendingTasks?: number;
  cancelledTasks?: number;
  eventCount?: number;
  lastEventType?: string | null;
  terminalState?: string | null;
  terminalMessage?: Record<string, unknown> | null;
  planArtifact?: RunPlanArtifact | null;
  permissionContext?: {
    state: {
      productMode: string;
      approvalPolicy: string;
      executionScope: string;
      workflowIntent: string;
    };
    label: PermissionRuntimeLabel;
    resolverInput: WorkflowIntentResolverInput;
    resolvedAt: string;
  } | null;
  pendingApproval?: ApprovalRequest | null;
}

interface UseRunSummaryResult {
  summary: RunSummary | null;
}

const SUMMARY_ERROR_LOG_WINDOW_MS = 30_000;
const RUN_SUMMARY_MIN_FETCH_INTERVAL_MS = 10_000;
const RUN_SUMMARY_FORCE_MIN_FETCH_INTERVAL_MS = 3_000;

interface RunSummaryRequestState {
  inFlight: Promise<RunSummaryFetchResult> | null;
  lastFetchAt: number;
  cachedSummary: RunSummary | null;
  hasCachedSummary: boolean;
}

type RunSummaryFetchResult =
  | {
      kind: "summary";
      summary: RunSummary;
      status: number;
      fromCache: boolean;
    }
  | {
      kind: "unavailable";
      status: number;
      statusText: string;
      fromCache: false;
    }
  | {
      kind: "throttled";
      summary: RunSummary | null;
      fromCache: true;
    };

const runSummaryRequestsByRunId = new Map<string, RunSummaryRequestState>();

export function __resetRunSummaryRequestCacheForTests(): void {
  runSummaryRequestsByRunId.clear();
}

export function useRunSummary(
  runId: string,
  shouldPoll: boolean,
): UseRunSummaryResult {
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const activeRunIdRef = useRef(runId);
  const inFlightRef = useRef(false);
  const lastSummaryErrorLogRef = useRef<{
    timestamp: number;
    message: string;
  } | null>(null);
  const summaryStatusRef = useRef<string | null>(null);
  const pendingApprovalRequestId = summary?.pendingApproval?.requestId ?? null;
  const summaryStatus = summary?.status ?? null;

  useEffect(() => {
    activeRunIdRef.current = runId;
    inFlightRef.current = false;
    setSummary(null);
  }, [runId]);

  const fetchSummary = useCallback(
    async (options?: { force?: boolean }) => {
      const currentRunId = runId.trim();
      if (!currentRunId) {
        setSummary(null);
        return;
      }
      if (inFlightRef.current) {
        return;
      }

      try {
        inFlightRef.current = true;
        const result = await requestRunSummary(currentRunId, {
          force: Boolean(options?.force),
        });
        if (activeRunIdRef.current !== currentRunId) {
          return;
        }
        if (result.kind === "unavailable") {
          return;
        }
        const payload = result.summary;
        if (!payload) {
          return;
        }
        if (activeRunIdRef.current !== currentRunId) {
          return;
        }
        if (payload.runId !== currentRunId) {
          return;
        }
        setSummary(payload);
      } catch (error) {
        if (activeRunIdRef.current !== currentRunId) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const previous = lastSummaryErrorLogRef.current;
        const shouldLog =
          !previous ||
          previous.message !== message ||
          Date.now() - previous.timestamp >= SUMMARY_ERROR_LOG_WINDOW_MS;
        if (shouldLog) {
          console.warn(
            `[run/summary] failed to fetch summary for runId=${currentRunId}: ${message}`,
          );
          lastSummaryErrorLogRef.current = {
            timestamp: Date.now(),
            message,
          };
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
    summaryStatusRef.current = summaryStatus;
  }, [summaryStatus]);

  useEffect(() => {
    if (!runId || !shouldPoll) {
      return;
    }
    void fetchSummary();
  }, [fetchSummary, runId, shouldPoll]);

  useEffect(() => {
    if (!runId || !shouldPoll) {
      return;
    }

    const handleRefreshEvent = (event: Event) => {
      const customEvent = event as CustomEvent<
        Partial<RunSummaryRefreshDetail>
      >;
      if (customEvent.detail?.runId !== runId) {
        return;
      }
      if (customEvent.detail?.source === "run-event-stream") {
        return;
      }

      const shouldSkipTerminalSummary = isTerminalWithoutPendingApproval(
        summaryStatus,
        pendingApprovalRequestId,
      );
      if (shouldSkipTerminalSummary || document.visibilityState !== "visible") {
        return;
      }
      const approvalIsVisible =
        isApprovalRequiredRunStatus(summaryStatus) ||
        Boolean(pendingApprovalRequestId);
      void fetchSummary({ force: approvalIsVisible });
    };

    window.addEventListener(RUN_SUMMARY_REFRESH_EVENT, handleRefreshEvent);
    return () => {
      window.removeEventListener(RUN_SUMMARY_REFRESH_EVENT, handleRefreshEvent);
    };
  }, [
    fetchSummary,
    pendingApprovalRequestId,
    runId,
    shouldPoll,
    summaryStatus,
  ]);

  return { summary };
}

async function requestRunSummary(
  runId: string,
  options: { force: boolean },
): Promise<RunSummaryFetchResult> {
  const state = getRunSummaryRequestState(runId);
  if (state.inFlight) {
    return state.inFlight;
  }

  const now = Date.now();
  const minInterval = options.force
    ? RUN_SUMMARY_FORCE_MIN_FETCH_INTERVAL_MS
    : RUN_SUMMARY_MIN_FETCH_INTERVAL_MS;
  if (state.lastFetchAt > 0 && now - state.lastFetchAt < minInterval) {
    return {
      kind: "throttled",
      summary: state.cachedSummary,
      fromCache: true,
    };
  }

  state.lastFetchAt = now;
  const request = fetchRunSummary(runId).finally(() => {
    const latest = runSummaryRequestsByRunId.get(runId);
    if (latest) {
      latest.inFlight = null;
    }
  });
  state.inFlight = request;
  return request;
}

function getRunSummaryRequestState(runId: string): RunSummaryRequestState {
  const existing = runSummaryRequestsByRunId.get(runId);
  if (existing) {
    return existing;
  }
  const created: RunSummaryRequestState = {
    inFlight: null,
    lastFetchAt: 0,
    cachedSummary: null,
    hasCachedSummary: false,
  };
  runSummaryRequestsByRunId.set(runId, created);
  return created;
}

async function fetchRunSummary(runId: string): Promise<RunSummaryFetchResult> {
  const response = await fetch(
    `${getBrainHttpBase()}/api/run/summary?runId=${encodeURIComponent(runId)}`,
    { credentials: "include" },
  );
  if (!response.ok) {
    return {
      kind: "unavailable",
      status: response.status,
      statusText: response.statusText,
      fromCache: false,
    };
  }
  const summary = (await response.json()) as RunSummary;
  const state = getRunSummaryRequestState(runId);
  state.cachedSummary = summary;
  state.hasCachedSummary = true;
  return {
    kind: "summary",
    summary,
    status: response.status,
    fromCache: false,
  };
}

function isTerminalWithoutPendingApproval(
  status: string | null,
  pendingApprovalRequestId: string | null,
): boolean {
  return (
    isTerminalRunStatus(status) &&
    !isApprovalRequiredRunStatus(status) &&
    !pendingApprovalRequestId
  );
}
