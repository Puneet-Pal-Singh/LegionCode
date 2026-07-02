import { useCallback, useEffect, useRef, useState } from "react";
import { getBrainHttpBase } from "../lib/platform-endpoints.js";
import {
  isApprovalRequiredRunStatus,
  isTerminalRunStatus,
} from "../lib/run-status.js";
import { RUN_SUMMARY_REFRESH_EVENT } from "../lib/run-summary-events.js";
import { logClientEvent } from "../lib/client-logger.js";
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
const RUN_SUMMARY_MIN_FETCH_INTERVAL_MS = 2_000;
const RUN_SUMMARY_FORCE_MIN_FETCH_INTERVAL_MS = 1_000;
const RUN_SUMMARY_POLL_INTERVAL_MS = 6_000;

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
  const lastLoggedSummaryRef = useRef("");
  const pendingApprovalRequestId = summary?.pendingApproval?.requestId ?? null;
  const summaryStatus = summary?.status ?? null;

  useEffect(() => {
    activeRunIdRef.current = runId;
    inFlightRef.current = false;
    lastLoggedSummaryRef.current = "";
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
        logClientEvent("run/summary", "fetch-started", {
          runId: currentRunId,
          force: Boolean(options?.force),
          shouldPoll,
          currentStatus: summaryStatusRef.current,
        });
        const result = await requestRunSummary(currentRunId, {
          force: Boolean(options?.force),
        });
        if (activeRunIdRef.current !== currentRunId) {
          logClientEvent("run/summary", "fetch-discarded", {
            runId: currentRunId,
            activeRunId: activeRunIdRef.current,
            reason: "run-changed-after-response",
            status: result.kind === "unavailable" ? result.status : 200,
          });
          return;
        }
        if (result.kind === "unavailable") {
          logClientEvent("run/summary", "unavailable", {
            runId: currentRunId,
            status: result.status,
            statusText: result.statusText,
          });
          return;
        }
        const payload = result.summary;
        if (!payload) {
          return;
        }
        if (activeRunIdRef.current !== currentRunId) {
          logClientEvent("run/summary", "payload-discarded", {
            runId: currentRunId,
            activeRunId: activeRunIdRef.current,
            reason: "run-changed-after-payload",
            payloadRunId: payload.runId,
            payloadStatus: payload.status,
          });
          return;
        }
        if (payload.runId !== currentRunId) {
          logClientEvent("run/summary", "payload-run-mismatch", {
            runId: currentRunId,
            payloadRunId: payload.runId,
            payloadStatus: payload.status,
          });
          return;
        }
        const summarySignature = `${payload.status}:${payload.eventCount ?? 0}:${payload.pendingApproval?.requestId ?? ""}`;
        if (lastLoggedSummaryRef.current !== summarySignature) {
          lastLoggedSummaryRef.current = summarySignature;
          logClientEvent("run/summary", "updated", {
            runId: currentRunId,
            status: payload.status,
            eventCount: payload.eventCount,
            hasPendingApproval: Boolean(payload.pendingApproval),
          });
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
    [runId, shouldPoll],
  );

  useEffect(() => {
    summaryStatusRef.current = summaryStatus;
  }, [summaryStatus]);

  useEffect(() => {
    if (!runId) {
      return;
    }
    void fetchSummary();
  }, [fetchSummary, runId]);

  useEffect(() => {
    if (!runId) {
      return;
    }

    const handleRefreshEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ runId?: string }>;
      if (customEvent.detail?.runId !== runId) {
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

  useEffect(() => {
    if (!runId || !shouldKeepRunSummaryPolling(summary, shouldPoll)) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      if (inFlightRef.current) {
        return;
      }
      const currentStatus = summaryStatusRef.current;
      if (
        isTerminalWithoutPendingApproval(
          currentStatus,
          summary?.pendingApproval?.requestId ?? null,
        )
      ) {
        return;
      }
      void fetchSummary();
    }, RUN_SUMMARY_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchSummary, runId, shouldPoll, summary, summaryStatus]);

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
  if (state.hasCachedSummary && now - state.lastFetchAt < minInterval) {
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

function shouldKeepRunSummaryPolling(
  summary: RunSummary | null,
  shouldPoll: boolean,
): boolean {
  if (summary === null) {
    return true;
  }
  const status = summary.status ?? null;
  if (
    isTerminalWithoutPendingApproval(
      status,
      summary.pendingApproval?.requestId ?? null,
    )
  ) {
    return false;
  }
  if (summary.pendingApproval || isApprovalRequiredRunStatus(status)) {
    return true;
  }
  if (!isTerminalRunStatus(status)) {
    return true;
  }
  return shouldPoll;
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
