import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
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
  readonly error: string | null;
}

interface ProjectionState {
  readonly turnId: TurnId;
  readonly projection: LifecycleProjection;
}

interface ErrorState {
  readonly turnId: TurnId;
  readonly message: string;
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
    });
    return () => {
      abortController.abort();
    };
  }, [canonicalTurnId, lifecycleClient, shouldFollow]);

  return {
    projection:
      projectionState?.turnId === canonicalTurnId
        ? projectionState.projection
        : emptyProjection,
    error:
      errorState?.turnId === canonicalTurnId ? errorState.message : null,
  };
}

function normalizeCanonicalTurnId(
  turnId: string | null | undefined,
): TurnId | null {
  const trimmed = turnId?.trim();
  return trimmed?.startsWith("trn_") ? (trimmed as TurnId) : null;
}

interface FollowLifecycleInput {
  readonly turnId: TurnId;
  readonly lifecycleClient: LifecycleClient;
  readonly abortController: AbortController;
  readonly setProjectionState: Dispatch<SetStateAction<ProjectionState | null>>;
  readonly setErrorState: Dispatch<SetStateAction<ErrorState | null>>;
}

async function followLifecycle(input: FollowLifecycleInput): Promise<void> {
  try {
    for await (const event of input.lifecycleClient.followTurnLifecycle(
      { turnId: input.turnId },
      { signal: input.abortController.signal },
    )) {
      if (input.abortController.signal.aborted) {
        return;
      }
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
  } catch (error) {
    if (input.abortController.signal.aborted) {
      return;
    }
    input.setErrorState({
      turnId: input.turnId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
