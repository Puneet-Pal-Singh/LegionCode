import { useState } from "react";
import type { CommitPayload } from "@repo/shared-types";
import { useOptionalRunContext } from "./useRunContext";
import { GitMutationError, commitGitChanges } from "../lib/git-client.js";
import type { GitMutationErrorCode, GitMutationErrorMetadata } from "@repo/shared-types";

interface GitCommitErrorState {
  code?: GitMutationErrorCode;
  metadata?: GitMutationErrorMetadata;
}

interface UseGitCommitResult {
  committing: boolean;
  error: string | null;
  errorState: GitCommitErrorState | null;
  commit: (payload: CommitPayload) => Promise<boolean>;
}

export function useGitCommit(
  explicitRunId?: string,
  explicitSessionId?: string,
): UseGitCommitResult {
  const { runId: contextRunId, sessionId: contextSessionId } =
    useOptionalRunContext();
  const runId = explicitRunId ?? contextRunId;
  const sessionId = explicitSessionId ?? contextSessionId;
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<GitCommitErrorState | null>(null);

  const performCommit = async (payload: CommitPayload) => {
    if (!runId) {
      setError("No run context available");
      return false;
    }
    if (!sessionId) {
      setError("No session context available");
      return false;
    }

    setCommitting(true);
    setError(null);
    setErrorState(null);

    try {
      await commitGitChanges({
        runId,
        sessionId,
        payload,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      if (err instanceof GitMutationError) {
        setErrorState({ code: err.code, metadata: err.metadata });
      }
      console.error("[useGitCommit] Error:", err);
      return false;
    } finally {
      setCommitting(false);
    }
  };

  return { committing, error, errorState, commit: performCommit };
}
