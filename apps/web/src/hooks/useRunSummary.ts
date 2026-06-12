import { useCallback, useEffect, useRef, useState } from "react";
import { getBrainHttpBase } from "../lib/platform-endpoints.js";
import {
  isApprovalRequiredRunStatus,
  isTerminalRunStatus,
} from "../lib/run-status.js";
import { RUN_SUMMARY_REFRESH_EVENT } from "../lib/run-summary-events.js";
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
const RUN_SUMMARY_MIN_FETCH_INTERVAL_MS = 1_200;
const RUN_SUMMARY_POLL_INTERVAL_MS = 5_000;

export function useRunSummary(
  runId: string,
  shouldPoll: boolean,
): UseRunSummaryResult {
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const activeRunIdRef = useRef(runId);
  const inFlightRef = useRef(false);
  const inFlightRunIdRef = useRef<string | null>(null);
  const missingRunRef = useRef(false);
  const lastFetchAtRef = useRef(0);
  const lastSummaryErrorLogRef = useRef<{
    timestamp: number;
    message: string;
  } | null>(null);
  const summaryStatusRef = useRef<string | null>(null);
  const pendingApprovalRequestId = summary?.pendingApproval?.requestId ?? null;

  useEffect(() => {
    activeRunIdRef.current = runId;
    inFlightRef.current = false;
    inFlightRunIdRef.current = null;
    missingRunRef.current = false;
    lastFetchAtRef.current = 0;
    setSummary(null);
  }, [runId]);

  const fetchSummary = useCallback(async () => {
    const currentRunId = runId.trim();
    if (!currentRunId) {
      setSummary(null);
      return;
    }
    if (inFlightRef.current) {
      return;
    }
    if (missingRunRef.current) {
      return;
    }
    const now = Date.now();
    if (now - lastFetchAtRef.current < RUN_SUMMARY_MIN_FETCH_INTERVAL_MS) {
      return;
    }

    try {
      inFlightRef.current = true;
      inFlightRunIdRef.current = currentRunId;
      lastFetchAtRef.current = now;
      const response = await fetch(
        `${getBrainHttpBase()}/api/run/summary?runId=${encodeURIComponent(currentRunId)}`,
        { credentials: "include" },
      );
      if (activeRunIdRef.current !== currentRunId) {
        return;
      }
      if (!response.ok) {
        if (response.status === 404) {
          missingRunRef.current = true;
        }
        return;
      }
      const payload = (await response.json()) as RunSummary;
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
      if (inFlightRunIdRef.current === currentRunId) {
        inFlightRef.current = false;
        inFlightRunIdRef.current = null;
      }
    }
  }, [runId]);

  useEffect(() => {
    summaryStatusRef.current = summary?.status ?? null;
  }, [summary?.status]);

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

      const shouldSkipTerminalSummary =
        !shouldPoll &&
        isTerminalRunStatus(summary?.status) &&
        !isApprovalRequiredRunStatus(summary?.status) &&
        !pendingApprovalRequestId;
      if (shouldSkipTerminalSummary || document.visibilityState !== "visible") {
        return;
      }
      void fetchSummary();
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
    summary?.status,
  ]);

  useEffect(() => {
    if (!runId || !shouldPoll) {
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
      if (isTerminalRunStatus(currentStatus)) {
        return;
      }
      void fetchSummary();
    }, RUN_SUMMARY_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchSummary, runId, shouldPoll]);

  return { summary };
}
