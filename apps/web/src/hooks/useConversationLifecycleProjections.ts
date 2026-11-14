import { useEffect, useMemo, useState } from "react";
import { TurnIdSchema } from "@legioncode/sdk";
import type { ConversationTurn, PlatformClient, TurnId } from "@legioncode/sdk";
import { useAuthenticatedConversationLifecycleClient } from "./useAuthenticatedConversationLifecycleClient";
import {
  replayConversationLifecycleProjection,
  type LifecycleProjection,
} from "@legioncode/sdk";

type ProjectionMap = Readonly<Record<string, LifecycleProjection>>;

interface ConversationLifecycleProjectionState {
  readonly scope: HistoricalReadScope;
  readonly projections: ProjectionMap;
}

interface HistoricalReadScope {
  readonly client: Pick<PlatformClient, "replayLifecycleEvents">;
  readonly turnIdsKey: string;
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
  injectedClient?: Pick<PlatformClient, "replayLifecycleEvents">,
): ConversationLifecycleProjections {
  const { client, hasAuthenticatedOwner } = useAuthenticatedConversationLifecycleClient(injectedClient);
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
  const ownedReadScope = useMemo<HistoricalReadScope>(
    () => Object.freeze({ client, turnIdsKey }),
    [client, turnIdsKey],
  );
  const [state, setState] =
    useState<ConversationLifecycleProjectionState | null>(null);

  useEffect(() => {
    if (!hasAuthenticatedOwner) return;
    const abortController = new AbortController();
    void Promise.all(
      turnIds.map((turnId) =>
        replaySettledTurn(client, turnId, abortController),
      ),
    ).then((replayed) => {
      if (abortController.signal.aborted) return;
      setState({
        scope: ownedReadScope,
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
  }, [client, hasAuthenticatedOwner, ownedReadScope, turnIds]);

  // Before cleanup runs, an old completion can only write its captured scope.
  // Identical turn IDs never make another account's historical state visible.
  const isCurrent = hasAuthenticatedOwner && state?.scope === ownedReadScope;
  return {
    projections: isCurrent ? state.projections : {},
    isLoading: hasAuthenticatedOwner && turnIds.length > 0 && !isCurrent,
  };
}

async function replaySettledTurn(
  client: Pick<PlatformClient, "replayLifecycleEvents">,
  turnId: TurnId,
  abortController: AbortController,
): Promise<LifecycleProjection | null> {
  try {
    return await replayConversationLifecycleProjection({
      turnId,
      lifecycleClient: client,
      signal: abortController.signal,
    });
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
