import { useMemo } from "react";
import { TurnIdSchema } from "@repo/platform-client-sdk";
import { useTurnLifecycleProjection } from "../../../hooks/useTurnLifecycleProjection.js";
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";

export interface ActiveTurnProjection {
  readonly turnId: string | null;
  readonly projection: LifecycleProjection | null;
  readonly hasCanonicalTurn: boolean;
  readonly hasReplay: boolean;
  readonly isActive: boolean;
  readonly isTerminal: boolean;
  readonly isTransportPending: boolean;
}

export function useActiveTurnProjection(input: {
  turnId: string | null | undefined;
  transportLoading: boolean;
  enabled?: boolean;
}): ActiveTurnProjection {
  const normalizedTurnId = input.turnId?.trim() || null;
  const parsedTurnId = normalizedTurnId
    ? TurnIdSchema.safeParse(normalizedTurnId)
    : null;
  const turnId = parsedTurnId?.success ? parsedTurnId.data : null;
  const { projection } = useTurnLifecycleProjection(
    turnId,
    Boolean(turnId) && input.enabled !== false,
  );

  return useMemo(() => {
    const hasReplay = (projection?.lastSequence ?? 0) > 0;
    const isTerminal = Boolean(projection?.terminal);
    return {
      turnId,
      projection,
      hasCanonicalTurn: Boolean(turnId),
      hasReplay,
      isActive: hasReplay && !isTerminal,
      isTerminal,
      isTransportPending: input.transportLoading && !turnId,
    };
  }, [input.transportLoading, projection, turnId]);
}
