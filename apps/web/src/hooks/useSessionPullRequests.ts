import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostedSessionPullRequestsResponse } from "@legioncode/sdk";
import type { AgentSession } from "./useSessionManager";
import { getSessionPullRequests } from "../services/api/sessionMetadata";

const CACHE_TTL_MS = 30_000;
const REQUEST_CONCURRENCY = 2;

type PullRequestResult = HostedSessionPullRequestsResponse;
type CachedResult = { key: string; fetchedAt: number; result: PullRequestResult };
const MAX_CACHE_ENTRIES = 300;

function resultKey(accountId: string, session: AgentSession): string {
  return `${accountId}\0${session.id}\0${session.updatedAt}`;
}

/** Loads verified PR metadata only for rows the sidebar has made visible. */
export function useSessionPullRequests(
  sessions: readonly AgentSession[],
  visibleSessionIds: ReadonlySet<string>,
  accountId: string | null,
) {
  const [prioritySessionId, setPrioritySessionId] = useState<string | null>(null);
  const [cacheRevision, setCacheRevision] = useState(0);
  const cacheRef = useRef(new Map<string, CachedResult>());
  const visibleKey = Array.from(visibleSessionIds).sort().join("\0");
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);

  const saveResult = useCallback((sessionId: string, cached: CachedResult) => {
    const sessionPrefix = `${accountId}\0${sessionId}\0`;
    for (const key of cacheRef.current.keys()) {
      if (key.startsWith(sessionPrefix)) cacheRef.current.delete(key);
    }
    cacheRef.current.set(cached.key, cached);
    while (cacheRef.current.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cacheRef.current.keys().next().value;
      if (oldestKey === undefined) break;
      cacheRef.current.delete(oldestKey);
    }
  }, [accountId]);

  useEffect(() => {
    cacheRef.current.clear();
    setCacheRevision((revision) => revision + 1);
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    let generationCurrent = true;
    const ids = visibleKey ? visibleKey.split("\0") : [];
    const orderedIds = prioritySessionId && ids.includes(prioritySessionId)
      ? [prioritySessionId, ...ids.filter((id) => id !== prioritySessionId)]
      : ids;
    const now = Date.now();
    const pending = orderedIds.flatMap((id) => {
      const session = sessionsById.get(id);
      if (!session) return [];
      const key = resultKey(accountId, session);
      const cached = cacheRef.current.get(key);
      if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return [];
      return [{ id, key }];
    });
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (generationCurrent && nextIndex < pending.length) {
        const entry = pending[nextIndex++];
        if (!entry) return;
        try {
          const result = await getSessionPullRequests(entry.id, controller.signal);
          if (!generationCurrent) return;
          const cached = { key: entry.key, fetchedAt: Date.now(), result };
          saveResult(entry.id, cached);
          setCacheRevision((revision) => revision + 1);
        } catch {
          if (!generationCurrent || controller.signal.aborted) return;
          const cached: CachedResult = {
            key: entry.key,
            fetchedAt: Date.now(),
            result: { status: "unavailable", sessionId: entry.id },
          };
          saveResult(entry.id, cached);
          setCacheRevision((revision) => revision + 1);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(REQUEST_CONCURRENCY, pending.length) }, () => worker()));
    return () => {
      generationCurrent = false;
      controller.abort();
    };
  }, [accountId, prioritySessionId, saveResult, sessionsById, visibleKey]);

  const prioritizeSession = useCallback((sessionId: string | null) => {
    setPrioritySessionId(sessionId);
  }, []);

  const pullRequestsBySessionId = useMemo(() => {
    const projected = new Map<string, PullRequestResult>();
    for (const sessionId of visibleSessionIds) {
      const session = sessionsById.get(sessionId);
      if (!session || !accountId) continue;
      const key = resultKey(accountId, session);
      const cached = cacheRef.current.get(key);
      if (cached?.key === key) projected.set(sessionId, cached.result);
    }
    return projected;
  }, [accountId, sessionsById, visibleSessionIds, cacheRevision]);

  return { pullRequestsBySessionId, prioritizeSession };
}
