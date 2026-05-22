import { useState } from "react";
import type { DiffContent } from "@repo/shared-types";
import { useRunContext } from "./useRunContext";
import { getGitDiff } from "../lib/git-client.js";

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
  const { runId: contextRunId, sessionId: contextSessionId } = useRunContext();
  const runId = explicitRunId ?? contextRunId;
  const sessionId = explicitSessionId ?? contextSessionId;
  const [diff, setDiff] = useState<DiffContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDiff = async (path: string, staged = false) => {
    if (!runId || !sessionId) {
      setError(!runId ? "No run context available" : "No session context available");
      return;
    }

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
      setDiff(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      console.error("[useGitDiff] Error:", err);
    } finally {
      setLoading(false);
    }
  };

  return { diff, loading, error, fetch: fetchDiff };
}
