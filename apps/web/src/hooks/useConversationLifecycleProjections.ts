import { useEffect, useMemo, useState } from "react";
import { TurnIdSchema } from "@repo/platform-client-sdk";
import type { ConversationTurn } from "../components/chat/messageMetadata";
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

type ProjectionMap = Readonly<Record<string, LifecycleProjection>>;

interface ConversationLifecycleProjectionState {
  readonly key: string;
  readonly projections: ProjectionMap;
}

export interface ConversationLifecycleProjections {
  readonly projections: ProjectionMap;
  readonly isLoading: boolean;
}

/**
 * Replays settled transcript turns from canonical lifecycle storage.
 *
 * The active turn is followed by useActiveTurnProjection; this hook only
 * restores historical turns, preventing a second live poller for the same
 * turn while still making refresh reproduce the original workflow.
 */
export function useConversationLifecycleProjections(
  turns: readonly ConversationTurn[],
  activeTurnId: string | null | undefined,
  injectedClient?: LifecycleClient,
): ConversationLifecycleProjections {
  const client = useMemo(
    () => injectedClient ?? createLifecycleClient(),
    [injectedClient],
  );
  const turnIds = useMemo(
    () => [
      ...new Set(
        turns
          .map((turn) => TurnIdSchema.safeParse(turn.turnId))
          .filter((result) => result.success)
          .map((result) => result.data)
          .filter((turnId) => turnId !== activeTurnId),
      ),
    ],
    [activeTurnId, turns],
  );
  const turnIdsKey = turnIds.join("\u0000");
  const [state, setState] =
    useState<ConversationLifecycleProjectionState | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    void Promise.all(
      turnIds.map((turnId) =>
        replaySettledTurn(client, turnId, abortController),
      ),
    ).then((replayed) => {
      if (abortController.signal.aborted) return;
      setState({
        key: turnIdsKey,
        projections: Object.fromEntries(
          replayed
            .filter(
              (projection): projection is LifecycleProjection =>
                projection !== null,
            )
            .map((projection) => [projection.turnId, projection]),
        ),
      });
    });
    return () => abortController.abort();
  }, [client, turnIdsKey]);

  const isCurrent = state?.key === turnIdsKey;
  return {
    projections: isCurrent ? state.projections : {},
    isLoading: turnIds.length > 0 && !isCurrent,
  };
}

async function replaySettledTurn(
  client: LifecycleClient,
  turnId: TurnId,
  abortController: AbortController,
): Promise<LifecycleProjection | null> {
  let projection = createLifecycleProjection(turnId);
  try {
    let afterSequence = null;
    do {
      const replay = await client.replayLifecycleEvents(
        { turnId, afterSequence, limit: 1_000 },
        { signal: abortController.signal },
      );
      if (abortController.signal.aborted) return null;
      for (const event of replay.events) {
        projection = applyLifecycleEvent(projection, event);
      }
      afterSequence = replay.nextSequence;
    } while (afterSequence !== null);
    return projection;
  } catch (error) {
    // The transcript remains usable if an old lifecycle is unavailable.
    // Current-turn failures are surfaced by useActiveTurnProjection.
    if (!abortController.signal.aborted) {
      console.warn(
        `[workflow/replay] Historical lifecycle unavailable for turn ${turnId}`,
        error,
      );
    }
    return null;
  }
}
