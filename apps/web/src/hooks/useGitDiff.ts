import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffContent } from "@repo/shared-types";
import { useOptionalRunContext } from "./useRunContext";
import { getGitDiff } from "../lib/git-client.js";
import { logClientEvent, logClientWarning } from "../lib/client-logger.js";

interface UseGitDiffResult {
  diff: DiffContent | null;
  loading: boolean;
  error: string | null;
  fetch: (path: string, staged?: boolean) => Promise<void>;
}

export function useGitDiff(
  explicitRunId?: string,
  explicitSessionId?: string,
): UseGitDiffResult {
  const { runId: contextRunId, sessionId: contextSessionId } =
    useOptionalRunContext();
  const runId = explicitRunId ?? contextRunId;
  const sessionId = explicitSessionId ?? contextSessionId;
  const scopeKey = runId && sessionId ? `${sessionId}:${runId}` : null;
  const [diff, setDiff] = useState<DiffContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeScopeKeyRef = useRef(scopeKey);
  const latestRequestIdRef = useRef(0);
  const diffRef = useRef<DiffContent | null>(null);
  const previousDiffRef = useRef<DiffContent | null>(null);

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    previousDiffRef.current = null;
    diffRef.current = null;
    setDiff(null);
    setLoading(false);
    setError(null);
  }, [scopeKey]);

  const fetchDiff = useCallback(
    async (path: string, staged = false) => {
      const requestId = ++latestRequestIdRef.current;
      const requestScopeKey = scopeKey;
      if (!runId || !sessionId) {
        const message = !runId
          ? "No run context available"
          : "No session context available";
        logClientWarning("git/diff", "skipped", {
          path,
          reason: message,
        });
        setError(message);
        return;
      }

      logClientEvent("git/diff", "requested", {
        runId,
        path,
        staged,
        requestId,
      });

      previousDiffRef.current = diffRef.current;
      setDiff(null);
      setLoading(true);
      setError(null);

      try {
        const params = {
          runId,
          sessionId,
          path,
          staged,
        };
        const data = (await getGitDiff(params)) as DiffContent;
        if (
          requestId !== latestRequestIdRef.current ||
          activeScopeKeyRef.current !== requestScopeKey
        ) {
          logClientEvent("git/diff", "discarded", {
            runId,
            path,
            requestId,
            currentRequestId: latestRequestIdRef.current,
            reason:
              activeScopeKeyRef.current === requestScopeKey
                ? "newer-request"
                : "scope-changed",
          });
          return;
        }
        diffRef.current = data;
        setDiff(data);
        logClientEvent("git/diff", "accepted", {
          runId,
          path,
          requestId,
          hunkCount: data.hunks.length,
        });
      } catch (err) {
        if (
          requestId !== latestRequestIdRef.current ||
          activeScopeKeyRef.current !== requestScopeKey
        ) {
          logClientEvent("git/diff", "failure-discarded", {
            runId,
            path,
            requestId,
          });
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        logClientWarning("git/diff", "failed", {
          runId,
          path,
          requestId,
          error: message,
        });
        setError(message);
        const previous = previousDiffRef.current;
        previousDiffRef.current = null;
        diffRef.current = previous;
        setDiff(previous);
      } finally {
        if (
          requestId === latestRequestIdRef.current &&
          activeScopeKeyRef.current === requestScopeKey
        ) {
          setLoading(false);
        }
      }
    },
    [runId, scopeKey, sessionId],
  );

  return { diff, loading, error, fetch: fetchDiff };
}
