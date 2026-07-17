import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffContent, EditArtifactIdentity } from "@repo/shared-types";
import { getEditArtifactDiff } from "../lib/edit-artifacts-client.js";

export interface UseEditArtifactDiffResult {
  diff: DiffContent | null;
  loading: boolean;
  error: string | null;
  fetch: (path: string) => Promise<void>;
}

export function useEditArtifactDiff(
  artifactId: string | undefined,
  identity: EditArtifactIdentity | null,
): UseEditArtifactDiffResult {
  const [diff, setDiff] = useState<DiffContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Record<string, DiffContent>>({});
  const latestRequestIdRef = useRef(0);

  useEffect(() => {
    cacheRef.current = {};
    latestRequestIdRef.current += 1;
    setDiff(null);
    setLoading(false);
    setError(null);
  }, [artifactId, identity]);

  const fetchDiff = useCallback(
    async (path: string): Promise<void> => {
      if (!artifactId || !identity) {
        latestRequestIdRef.current += 1;
        setError("No edit artifact selected");
        return;
      }

      const cacheKey = `${artifactId}:${path}`;
      const cachedDiff = cacheRef.current[cacheKey];
      if (cachedDiff) {
        setDiff(cachedDiff);
        setError(null);
        return;
      }

      const requestId = ++latestRequestIdRef.current;
      setDiff(null);
      setLoading(true);
      setError(null);

      try {
        const response = await getEditArtifactDiff({
          artifactId,
          path,
          identity,
        });
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        cacheRef.current[cacheKey] = response.diff;
        setDiff(response.diff);
      } catch (err) {
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        setDiff(null);
      } finally {
        if (requestId === latestRequestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [artifactId, identity],
  );

  return { diff, loading, error, fetch: fetchDiff };
}
