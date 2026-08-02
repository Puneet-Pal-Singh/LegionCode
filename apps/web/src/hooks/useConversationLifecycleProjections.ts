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
): ProjectionMap {
  const client = useMemo(
    () => injectedClient ?? createLifecycleClient(),
    [injectedClient],
  );
  const turnIds = useMemo(
    () =>
      [...new Set(
        turns
          .map((turn) => TurnIdSchema.safeParse(turn.turnId))
          .filter((result) => result.success)
          .map((result) => result.data)
          .filter((turnId) => turnId !== activeTurnId),
      )],
    [activeTurnId, turns],
  );
  const turnIdsKey = turnIds.join("\u0000");
  const [projections, setProjections] = useState<ProjectionMap>({});

  useEffect(() => {
    const abortController = new AbortController();
    for (const turnId of turnIds) {
      void replaySettledTurn(client, turnId, abortController, setProjections);
    }
    return () => abortController.abort();
  }, [client, turnIdsKey]);

  return projections;
}

async function replaySettledTurn(
  client: LifecycleClient,
  turnId: TurnId,
  abortController: AbortController,
  setProjections: React.Dispatch<React.SetStateAction<ProjectionMap>>,
): Promise<void> {
  let projection = createLifecycleProjection(turnId);
  try {
    for await (const event of client.followTurnLifecycle(
      { turnId },
      { signal: abortController.signal },
    )) {
      if (abortController.signal.aborted) return;
      projection = applyLifecycleEvent(projection, event);
      setProjections((current) => ({ ...current, [turnId]: projection }));
    }
  } catch (error) {
    // The transcript remains usable if an old lifecycle is unavailable.
    // Current-turn failures are surfaced by useActiveTurnProjection.
    if (!abortController.signal.aborted) {
      console.warn(
        `[workflow/replay] Historical lifecycle unavailable for turn ${turnId}`,
        error,
      );
    }
  }
}
