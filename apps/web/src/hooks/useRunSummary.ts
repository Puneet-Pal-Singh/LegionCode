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
  const lastFetchAtRef = useRef(0);
  const lastSummaryErrorLogRef = useRef<{
    timestamp: number;
    message: string;
  } | null>(null);
  const summaryStatusRef = useRef<string | null>(null);
  const lastLoggedSummaryRef = useRef("");
  const pendingApprovalRequestId = summary?.pendingApproval?.requestId ?? null;

  useEffect(() => {
    activeRunIdRef.current = runId;
    inFlightRef.current = false;
    inFlightRunIdRef.current = null;
    lastFetchAtRef.current = 0;
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
      const now = Date.now();
      if (
        !options?.force &&
        now - lastFetchAtRef.current < RUN_SUMMARY_MIN_FETCH_INTERVAL_MS
      ) {
        return;
      }

      try {
        inFlightRef.current = true;
        inFlightRunIdRef.current = currentRunId;
        lastFetchAtRef.current = now;
        logClientEvent("run/summary", "fetch-started", {
          runId: currentRunId,
          force: Boolean(options?.force),
          shouldPoll,
          currentStatus: summaryStatusRef.current,
        });
        const response = await fetch(
          `${getBrainHttpBase()}/api/run/summary?runId=${encodeURIComponent(currentRunId)}`,
          { credentials: "include" },
        );
        if (activeRunIdRef.current !== currentRunId) {
          logClientEvent("run/summary", "fetch-discarded", {
            runId: currentRunId,
            activeRunId: activeRunIdRef.current,
            reason: "run-changed-after-response",
            status: response.status,
          });
          return;
        }
        if (!response.ok) {
          logClientEvent("run/summary", "unavailable", {
            runId: currentRunId,
            status: response.status,
            statusText: response.statusText,
          });
          return;
        }
        const payload = (await response.json()) as RunSummary;
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
        if (inFlightRunIdRef.current === currentRunId) {
          inFlightRef.current = false;
          inFlightRunIdRef.current = null;
        }
      }
    },
    [runId, shouldPoll],
  );

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
      void fetchSummary({ force: true });
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
    const isMissingCanonicalSummary = summary === null;
    const shouldSettleCanonicalStatus =
      Boolean(summary?.status) &&
      !isTerminalRunStatus(summary?.status) &&
      !isApprovalRequiredRunStatus(summary?.status);
    const isApprovalActive = isApprovalRequiredRunStatus(summary?.status);
    if (
      !runId ||
      (!shouldPoll &&
        !isMissingCanonicalSummary &&
        !shouldSettleCanonicalStatus &&
        !isApprovalActive)
    ) {
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
        isTerminalRunStatus(currentStatus) &&
        !isApprovalRequiredRunStatus(currentStatus)
      ) {
        return;
      }
      void fetchSummary();
    }, RUN_SUMMARY_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchSummary, runId, shouldPoll, summary?.status]);

  return { summary };
}
