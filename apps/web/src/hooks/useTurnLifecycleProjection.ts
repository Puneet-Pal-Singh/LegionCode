import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TurnIdSchema,
  followConversationLifecycleProjection,
  type PlatformClient,
  type TurnId,
} from "@legioncode/sdk";
import { createWebPlatformClient } from "../services/api/platformClient";
import {
  createLifecycleProjection,
  type LifecycleProjection,
} from "@legioncode/sdk";

interface UseTurnLifecycleProjectionResult {
  readonly projection: LifecycleProjection | null;
  readonly isReplayReady: boolean;
  readonly error: string | null;
  readonly continuationStatus:
    | "replaying"
    | "following"
    | "reconnecting"
    | "stopped"
    | null;
  readonly retry: () => void;
}

interface ProjectionState {
  readonly turnId: TurnId;
  readonly projection: LifecycleProjection;
}

interface ErrorState {
  readonly turnId: TurnId;
  readonly message: string;
}

interface ContinuationStatusState {
  readonly turnId: TurnId;
  readonly status: "replaying" | "following" | "reconnecting" | "stopped";
}

export function useTurnLifecycleProjection(
  turnId: string | null | undefined,
  shouldFollow: boolean,
  injectedClient?: Pick<PlatformClient, "replayLifecycleEvents" | "followTurnLifecycle">,
): UseTurnLifecycleProjectionResult {
  const lifecycleClient = useMemo(
    () => injectedClient ?? createWebPlatformClient(),
    [injectedClient],
  );
  const canonicalTurnId = normalizeCanonicalTurnId(turnId);
  const emptyProjection = useMemo(
    () => (canonicalTurnId ? createLifecycleProjection(canonicalTurnId) : null),
    [canonicalTurnId],
  );
  const [projectionState, setProjectionState] =
    useState<ProjectionState | null>(null);
  const [errorState, setErrorState] = useState<ErrorState | null>(null);
  const [continuationStatus, setContinuationStatus] =
    useState<ContinuationStatusState | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const retry = useCallback(
    () => setRetryRevision((revision) => revision + 1),
    [],
  );

  useEffect(() => {
    if (!canonicalTurnId || !shouldFollow) {
      return;
    }

    const abortController = new AbortController();
    void followConversationLifecycleProjection({
      turnId: canonicalTurnId,
      lifecycleClient,
      signal: abortController.signal,
      onProjection: (projection) =>
        setProjectionState({ turnId: canonicalTurnId, projection }),
      onStatus: (status) => {
        if (status === "replaying") setErrorState(null);
        setContinuationStatus(
          status ? { turnId: canonicalTurnId, status } : null,
        );
      },
    }).catch((error: unknown) => {
      if (abortController.signal.aborted) return;
      setErrorState({
        turnId: canonicalTurnId,
        message: error instanceof Error ? error.message : String(error),
      });
      setContinuationStatus({ turnId: canonicalTurnId, status: "stopped" });
    });
    return () => {
      abortController.abort();
    };
  }, [canonicalTurnId, lifecycleClient, retryRevision, shouldFollow]);

  return {
    projection:
      projectionState?.turnId === canonicalTurnId
        ? projectionState.projection
        : emptyProjection,
    isReplayReady: projectionState?.turnId === canonicalTurnId,
    error: errorState?.turnId === canonicalTurnId ? errorState.message : null,
    continuationStatus:
      continuationStatus?.turnId === canonicalTurnId
        ? continuationStatus.status
        : null,
    retry,
  };
}

function normalizeCanonicalTurnId(
  turnId: string | null | undefined,
): TurnId | null {
  const trimmed = turnId?.trim();
  const parsed = trimmed ? TurnIdSchema.safeParse(trimmed) : null;
  return parsed?.success ? parsed.data : null;
}
