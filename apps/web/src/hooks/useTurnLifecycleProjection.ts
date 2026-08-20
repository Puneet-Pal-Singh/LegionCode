import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { TurnIdSchema } from "@repo/platform-client-sdk";
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
  const parsed = trimmed ? TurnIdSchema.safeParse(trimmed) : null;
  return parsed?.success ? parsed.data : null;
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
    let projection = createLifecycleProjection(input.turnId);
    let afterSequence: number | null = null;

    // A historical replay is one read-model snapshot. Publishing each replayed
    // event separately exposes obsolete intermediate states (for example an
    // approval request that was resolved later in the same replay). Build the
    // complete snapshot off-screen, then publish it once.
    while (!input.abortController.signal.aborted) {
      const replay = await input.lifecycleClient.replayLifecycleEvents(
        {
          turnId: input.turnId,
          afterSequence,
          limit: 1_000,
        },
        { signal: input.abortController.signal },
      );
      for (const event of replay.events) {
        projection = applyLifecycleEvent(projection, event);
      }
      if (replay.events.length < 1_000 || replay.nextSequence === null) {
        break;
      }
      afterSequence = replay.nextSequence;
    }

    if (input.abortController.signal.aborted) return;
    input.setProjectionState({ turnId: input.turnId, projection });
    if (projection.terminal) return;

    for await (const event of input.lifecycleClient.followTurnLifecycle(
      {
        turnId: input.turnId,
        afterSequence: projection.lastSequence || null,
      },
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
