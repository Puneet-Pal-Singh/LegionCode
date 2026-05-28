import { useCallback, useEffect, useRef, useState } from "react";
import type { PromptArtifactReviewSource } from "@repo/shared-types";
import {
  getEditArtifactReviewSourceByMessage,
  getLatestEditArtifactReviewSource,
} from "../lib/edit-artifacts-client.js";

interface UseEditArtifactReviewSourceInput {
  runId?: string;
  sessionId?: string;
  assistantMessageId?: string;
  enabled: boolean;
}

interface UseEditArtifactReviewSourceResult {
  source: PromptArtifactReviewSource | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useEditArtifactReviewSource(
  input: UseEditArtifactReviewSourceInput,
): UseEditArtifactReviewSourceResult {
  const [source, setSource] = useState<PromptArtifactReviewSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refetch = useCallback(async (): Promise<void> => {
    if (!input.enabled || !input.runId) {
      requestIdRef.current += 1;
      setSource(null);
      setLoading(false);
      setError(null);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextSource = input.assistantMessageId
        ? await getEditArtifactReviewSourceByMessage({
            runId: input.runId,
            assistantMessageId: input.assistantMessageId,
          })
        : await getLatestEditArtifactReviewSource({
            runId: input.runId,
            sessionId: input.sessionId,
          });
      if (requestId !== requestIdRef.current) {
        return;
      }
      setSource(nextSource);
    } catch (err) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      setSource(null);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [input.assistantMessageId, input.enabled, input.runId, input.sessionId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { source, loading, error, refetch };
}
