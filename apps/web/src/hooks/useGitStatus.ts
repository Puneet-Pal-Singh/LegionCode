import { useEffect, useState, useCallback, useRef } from "react";
import type { GitStatusResponse } from "@repo/shared-types";
import { useOptionalRunContext } from "./useRunContext";
import { getGitStatus } from "../lib/git-client.js";
import { subscribeRuntimeBootChanges } from "../lib/runtime-boot-monitor.js";
import { RUN_SUMMARY_REFRESH_EVENT } from "../lib/run-summary-events.js";

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
const requestVersionByRunId = new Map<string, number>();
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
  enabled = true,
): UseGitStatusResult {
  const { runId: contextRunId, sessionId: contextSessionId } =
    useOptionalRunContext();
  const runId = enabled ? (explicitRunId ?? contextRunId) : null;
  const sessionId = enabled ? (explicitSessionId ?? contextSessionId) : null;
  const cacheKey = runId && sessionId ? `${sessionId}:${runId}` : null;
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [gitAvailable, setGitAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeCacheKeyRef = useRef(cacheKey);
  const isActiveCacheKey = useCallback(
    (candidateCacheKey: string | null) =>
      activeCacheKeyRef.current === candidateCacheKey,
    [],
  );
  const applyStatusSnapshot = useCallback(
    (nextStatus: GitStatusResponse | null) => {
      setStatus(nextStatus);
      setGitAvailable(nextStatus?.gitAvailable ?? true);
      setError(null);
    },
    [],
  );

  useEffect(() => {
    activeCacheKeyRef.current = cacheKey;
    setStatus(null);
    setGitAvailable(true);
    setLoading(false);
    setError(null);
  }, [cacheKey]);

  const fetchStatus = useCallback(
    async (force = false) => {
      const requestCacheKey = cacheKey;
      if (!runId || !sessionId || !cacheKey) {
        setLoading(false);
        applyStatusSnapshot(null);
        return;
      }

      const cached = readCachedStatus(cacheKey, force);
      if (!isActiveCacheKey(requestCacheKey)) {
        return;
      }
      applyStatusSnapshot(cached.status);
      if (cached.isFresh) {
        setLoading(false);
        return;
      }
      if (shouldSkipDueToRetry(cacheKey, force)) {
        return;
      }

      setLoading(true);
      setError(null);
      const requestVersion = force
        ? incrementGitStatusRequestVersion(cacheKey)
        : getGitStatusRequestVersion(cacheKey);

      try {
        const data = await getOrCreateGitStatusRequest(
          cacheKey,
          runId,
          sessionId,
        );
        if (
          !isActiveCacheKey(requestCacheKey) ||
          requestVersion !== getGitStatusRequestVersion(cacheKey)
        ) {
          return;
        }

        updateCachedStatus(cacheKey, data);
        retryAfterByRunId.delete(cacheKey);
        applyStatusSnapshot(data);
      } catch (err) {
        if (
          !isActiveCacheKey(requestCacheKey) ||
          requestVersion !== getGitStatusRequestVersion(cacheKey)
        ) {
          return;
        }
        const message = recordGitStatusFailure(cacheKey, err);
        applyStatusSnapshot(null);
        setError(message);
      } finally {
        if (isActiveCacheKey(requestCacheKey)) {
          setLoading(false);
        }
      }
    },
    [applyStatusSnapshot, cacheKey, isActiveCacheKey, runId, sessionId],
  );

  useEffect(() => {
    if (!cacheKey) {
      return;
    }

    const listener = (nextStatus: GitStatusResponse | null): void => {
      if (!isActiveCacheKey(cacheKey)) {
        return;
      }
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
  }, [applyStatusSnapshot, cacheKey, isActiveCacheKey]);

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

  useEffect(() => {
    if (!cacheKey || !runId) {
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleRefreshEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ runId?: string }>;
      if (customEvent.detail?.runId !== runId) {
        return;
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void fetchStatus(true);
      }, 800);
    };

    window.addEventListener(RUN_SUMMARY_REFRESH_EVENT, handleRefreshEvent);
    return () => {
      window.removeEventListener(RUN_SUMMARY_REFRESH_EVENT, handleRefreshEvent);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [cacheKey, fetchStatus, runId]);

  return { status, gitAvailable, loading, error, refetch: fetchStatus };
}

function readCachedStatus(
  cacheKey: string,
  force: boolean,
): { status: GitStatusResponse | null; isFresh: boolean } {
  const status = statusCacheByRunId.get(cacheKey) ?? null;
  const cachedAt = statusCacheTimestampByRunId.get(cacheKey) ?? 0;
  const cacheAgeMs = Date.now() - cachedAt;
  return {
    status,
    isFresh: Boolean(status && !force && cacheAgeMs < STATUS_CACHE_TTL_MS),
  };
}

function shouldSkipDueToRetry(cacheKey: string, force: boolean): boolean {
  const retryAfter = retryAfterByRunId.get(cacheKey);
  return Boolean(!force && retryAfter && Date.now() < retryAfter);
}

async function getOrCreateGitStatusRequest(
  cacheKey: string,
  runId: string,
  sessionId: string,
): Promise<GitStatusResponse> {
  const request =
    inflightByRunId.get(cacheKey) ?? createGitStatusRequest(runId, sessionId);
  inflightByRunId.set(cacheKey, request);
  return request;
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

function recordGitStatusFailure(cacheKey: string, err: unknown): string {
  const message = err instanceof Error ? err.message : "Unknown error";
  retryAfterByRunId.set(cacheKey, Date.now() + RETRY_DELAY_MS);
  if (lastLoggedErrorByRunId.get(cacheKey) !== message) {
    console.error("[useGitStatus] Error:", err);
    lastLoggedErrorByRunId.set(cacheKey, message);
  }
  return message;
}

function clearGitStatusCache(cacheKey: string): void {
  statusCacheByRunId.delete(cacheKey);
  statusCacheTimestampByRunId.delete(cacheKey);
  retryAfterByRunId.delete(cacheKey);
}

function getGitStatusRequestVersion(cacheKey: string): number {
  return requestVersionByRunId.get(cacheKey) ?? 0;
}

function incrementGitStatusRequestVersion(cacheKey: string): number {
  const nextVersion = getGitStatusRequestVersion(cacheKey) + 1;
  requestVersionByRunId.set(cacheKey, nextVersion);
  return nextVersion;
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
  requestVersionByRunId.clear();
  retryAfterByRunId.clear();
  lastLoggedErrorByRunId.clear();
  listenersByRunId.clear();
}
