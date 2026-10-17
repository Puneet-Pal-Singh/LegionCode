import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  TurnIdSchema,
  replayLifecycleEventsWithRetry,
  type LifecycleEvent,
} from "@repo/platform-client-sdk";
import {
  createLifecycleClient,
  type LifecycleClient,
  type TurnId,
} from "../services/api/lifecycleClient";
import {
  applyLifecycleEvent,
  createLifecycleProjection,
  type LifecycleProjection,
} from "../services/lifecycle/LifecycleProjection";

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
  injectedClient?: LifecycleClient,
): UseTurnLifecycleProjectionResult {
  const lifecycleClient = useMemo(
    () => injectedClient ?? createLifecycleClient(),
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
    void followLifecycle({
      turnId: canonicalTurnId,
      lifecycleClient,
      abortController,
      setProjectionState,
      setErrorState,
      setContinuationStatus,
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

interface FollowLifecycleInput {
  readonly turnId: TurnId;
  readonly lifecycleClient: LifecycleClient;
  readonly abortController: AbortController;
  readonly setProjectionState: Dispatch<SetStateAction<ProjectionState | null>>;
  readonly setErrorState: Dispatch<SetStateAction<ErrorState | null>>;
  readonly setContinuationStatus: Dispatch<
    SetStateAction<ContinuationStatusState | null>
  >;
}

async function followLifecycle(input: FollowLifecycleInput): Promise<void> {
  try {
    let projection = createLifecycleProjection(input.turnId);
    let afterSequence: number | null = null;
    let resumed = false;
    const resumedEvents: LifecycleEvent[] = [];
    const operationOptions = {
      signal: input.abortController.signal,
      onLifecycleContinuationStatus: (
        status: "replaying" | "following" | "reconnecting",
      ) => {
        if (input.abortController.signal.aborted) return;
        if (status === "following" && !resumed) {
          resumed = true;
          for (const event of resumedEvents) {
            projection = applyLifecycleEvent(projection, event);
          }
          if (resumedEvents.length > 0) {
            input.setProjectionState({ turnId: input.turnId, projection });
            resumedEvents.length = 0;
          }
        }
        input.setContinuationStatus({ turnId: input.turnId, status });
      },
    };
    input.setErrorState(null);
    input.setContinuationStatus({ turnId: input.turnId, status: "replaying" });

    // A historical replay is one read-model snapshot. Publishing each replayed
    // event separately exposes obsolete intermediate states (for example an
    // approval request that was resolved later in the same replay). Build the
    // complete snapshot off-screen, then publish it once.
    while (!input.abortController.signal.aborted) {
      const replay = await replayLifecycleEventsWithRetry(
        {
          options: operationOptions,
          replay: (request, options) =>
            input.lifecycleClient.replayLifecycleEvents(request, options),
        },
        {
          turnId: input.turnId,
          afterSequence,
          limit: 1_000,
        },
      );
      for (const event of replay.events) {
        projection = applyLifecycleEvent(projection, event);
      }
      if (replay.events.length < 1_000 || replay.nextSequence === null) {
        break;
      }
      afterSequence = projection.lastSequence || null;
    }

    if (input.abortController.signal.aborted) return;
    input.setProjectionState({ turnId: input.turnId, projection });
    if (projection.terminal) {
      input.setContinuationStatus(null);
      return;
    }

    for await (const event of input.lifecycleClient.followTurnLifecycle(
      {
        turnId: input.turnId,
        afterSequence: projection.lastSequence || null,
      },
      operationOptions,
    )) {
      if (input.abortController.signal.aborted) {
        return;
      }
      if (!resumed) {
        resumedEvents.push(event);
        continue;
      }
      projection = applyLifecycleEvent(projection, event);
      input.setProjectionState((current) => ({
        turnId: input.turnId,
        projection: applyLifecycleEvent(
          current?.turnId === input.turnId
            ? current.projection
            : createLifecycleProjection(input.turnId),
          event,
        ),
      }));
    }
    if (projection.terminal) {
      input.setContinuationStatus(null);
    }
  } catch (error) {
    if (input.abortController.signal.aborted) {
      return;
    }
    input.setErrorState({
      turnId: input.turnId,
      message: error instanceof Error ? error.message : String(error),
    });
    input.setContinuationStatus({ turnId: input.turnId, status: "stopped" });
  }
}
