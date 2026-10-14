import { useMemo } from "react";
import { TurnIdSchema } from "@repo/platform-client-sdk";
import { useTurnLifecycleProjection } from "./useTurnLifecycleProjection.js";
import type { LifecycleProjection } from "../services/lifecycle/LifecycleProjection";

export interface ActiveTurnProjection {
  readonly turnId: string | null;
  readonly projection: LifecycleProjection | null;
  readonly hasCanonicalTurn: boolean;
  readonly hasReplay: boolean;
  readonly isActive: boolean;
  readonly isTerminal: boolean;
  readonly isTransportPending: boolean;
  readonly continuationStatus:
    | "replaying"
    | "following"
    | "reconnecting"
    | "stopped"
    | null;
  readonly continuationError: string | null;
  readonly retryContinuation: () => void;
}

export function deriveCanonicalRunLoading(
  activeTurn: ActiveTurnProjection,
  transportPending: boolean,
): boolean {
  return activeTurn.hasCanonicalTurn
    ? !activeTurn.isTerminal
    : transportPending;
}

export function resolveActiveProjectionTurnId(input: {
  activeTurnId: string | null | undefined;
  serverTurnId: string | null;
  isSubmitting: boolean;
}): string | null {
  if (input.activeTurnId) {
    return input.activeTurnId;
  }
  return input.isSubmitting ? null : input.serverTurnId;
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
  const { projection, error, continuationStatus, retry } =
    useTurnLifecycleProjection(
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
      continuationStatus,
      continuationError: error,
      retryContinuation: retry,
    };
  }, [
    continuationStatus,
    error,
    input.transportLoading,
    projection,
    retry,
    turnId,
  ]);
}
