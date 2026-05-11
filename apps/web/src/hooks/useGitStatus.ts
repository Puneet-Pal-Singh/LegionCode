import { useEffect, useState, useCallback } from "react";
import type { GitStatusResponse } from "@repo/shared-types";
import { useRunContext } from "./useRunContext";
import { getGitStatus } from "../lib/git-client.js";
import { subscribeRuntimeBootChanges } from "../lib/runtime-boot-monitor.js";

interface UseGitStatusResult {
  status: GitStatusResponse | null;
  gitAvailable: boolean;
  loading: boolean;
  error: string | null;
  refetch: (force?: boolean) => Promise<void>;
}

const statusCacheByRunId = new Map<string, GitStatusResponse>();
const statusCacheTimestampByRunId = new Map<string, number>();
const inflightByRunId = new Map<string, Promise<GitStatusResponse>>();
const retryAfterByRunId = new Map<string, number>();
const lastLoggedErrorByRunId = new Map<string, string>();
const listenersByRunId = new Map<
  string,
  Set<(status: GitStatusResponse | null) => void>
>();

const RETRY_DELAY_MS = 5000;
const STATUS_CACHE_TTL_MS = 10_000;

export function useGitStatus(
  explicitRunId?: string,
  explicitSessionId?: string,
): UseGitStatusResult {
  const { runId: contextRunId, sessionId: contextSessionId } = useRunContext();
  const runId = explicitRunId ?? contextRunId;
  const sessionId = explicitSessionId ?? contextSessionId;
  const cacheKey = runId && sessionId ? `${sessionId}:${runId}` : null;
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [gitAvailable, setGitAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const applyStatusSnapshot = useCallback(
    (nextStatus: GitStatusResponse | null) => {
      setStatus(nextStatus);
      setGitAvailable(nextStatus?.gitAvailable ?? true);
      setError(null);
    },
    [],
  );

  const fetchStatus = useCallback(
    async (force = false) => {
      if (!runId || !sessionId || !cacheKey) {
        setLoading(false);
        applyStatusSnapshot(null);
        setError(!runId ? null : "No session context available");
        return;
      }

      const cachedStatus = statusCacheByRunId.get(cacheKey);
      const cachedAt = statusCacheTimestampByRunId.get(cacheKey) ?? 0;
      if (cachedStatus) {
        applyStatusSnapshot(cachedStatus);
        const cacheAgeMs = Date.now() - cachedAt;
        if (!force && cacheAgeMs < STATUS_CACHE_TTL_MS) {
          setLoading(false);
          return;
        }
      } else {
        applyStatusSnapshot(null);
      }

      const retryAfter = retryAfterByRunId.get(cacheKey);
      if (!force && retryAfter && Date.now() < retryAfter) {
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const request =
          inflightByRunId.get(cacheKey) ??
          createGitStatusRequest(runId, sessionId);
        inflightByRunId.set(cacheKey, request);
        const data = await request;

        updateCachedStatus(cacheKey, data);
        retryAfterByRunId.delete(cacheKey);
        applyStatusSnapshot(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        retryAfterByRunId.set(cacheKey, Date.now() + RETRY_DELAY_MS);
        applyStatusSnapshot(null);
        setError(message);
        if (lastLoggedErrorByRunId.get(cacheKey) !== message) {
          console.error("[useGitStatus] Error:", err);
          lastLoggedErrorByRunId.set(cacheKey, message);
        }
      } finally {
        setLoading(false);
      }
    },
    [applyStatusSnapshot, cacheKey, runId, sessionId],
  );

  useEffect(() => {
    if (!cacheKey) {
      return;
    }

    const listener = (nextStatus: GitStatusResponse | null): void => {
      applyStatusSnapshot(nextStatus);
    };

    const listeners = listenersByRunId.get(cacheKey) ?? new Set();
    listeners.add(listener);
    listenersByRunId.set(cacheKey, listeners);

    return () => {
      const currentListeners = listenersByRunId.get(cacheKey);
      if (!currentListeners) {
        return;
      }
      currentListeners.delete(listener);
      if (currentListeners.size === 0) {
        listenersByRunId.delete(cacheKey);
      }
    };
  }, [applyStatusSnapshot, cacheKey]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!cacheKey) {
      return;
    }

    return subscribeRuntimeBootChanges(() => {
      clearGitStatusCache(cacheKey);
      void fetchStatus(true);
    });
  }, [cacheKey, fetchStatus]);

  return { status, gitAvailable, loading, error, refetch: fetchStatus };
}

async function createGitStatusRequest(
  runId: string,
  sessionId: string,
): Promise<GitStatusResponse> {
  const cacheKey = `${sessionId}:${runId}`;
  try {
    return await getGitStatus({ runId, sessionId });
  } finally {
    inflightByRunId.delete(cacheKey);
  }
}

function clearGitStatusCache(cacheKey: string): void {
  statusCacheByRunId.delete(cacheKey);
  statusCacheTimestampByRunId.delete(cacheKey);
  retryAfterByRunId.delete(cacheKey);
}

function updateCachedStatus(cacheKey: string, status: GitStatusResponse): void {
  statusCacheByRunId.set(cacheKey, status);
  statusCacheTimestampByRunId.set(cacheKey, Date.now());
  listenersByRunId.get(cacheKey)?.forEach((listener) => listener(status));
}

export function _resetGitStatusStateForTests(): void {
  statusCacheByRunId.clear();
  statusCacheTimestampByRunId.clear();
  inflightByRunId.clear();
  retryAfterByRunId.clear();
  lastLoggedErrorByRunId.clear();
  listenersByRunId.clear();
}
