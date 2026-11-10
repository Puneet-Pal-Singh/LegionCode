import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TurnIdSchema,
  createLifecycleProjection,
  followConversationLifecycleProjection,
  mergeLifecycleProjections,
  type ConversationLifecycleContinuationStatus,
  type LifecycleProjection,
  type PlatformClient,
  type TurnId,
} from "@legioncode/sdk";

export type ConversationLifecycleClient = Pick<
  PlatformClient,
  "replayLifecycleEvents" | "followTurnLifecycle"
>;

type ReadScope = { readonly turnId: TurnId; readonly client: ConversationLifecycleClient };
type ProjectionState = ReadScope & { readonly projection: LifecycleProjection };
type ErrorState = ReadScope & { readonly message: string };
type StatusState = ReadScope & { readonly status: ConversationLifecycleContinuationStatus | "stopped" };

/** React delivery only; SDK replay/continuation owns lifecycle ordering and truth. */
export function useConversationTurnLifecycle(
  turnId: string | null | undefined,
  shouldFollow: boolean,
  lifecycleClient: ConversationLifecycleClient,
) {
  const parsed = TurnIdSchema.safeParse(turnId?.trim());
  const canonicalTurnId = parsed.success ? parsed.data : null;
  const emptyProjection = useMemo(
    () => canonicalTurnId ? createLifecycleProjection(canonicalTurnId) : null,
    [canonicalTurnId],
  );
  const [projectionState, setProjectionState] = useState<ProjectionState | null>(null);
  const [errorState, setErrorState] = useState<ErrorState | null>(null);
  const [statusState, setStatusState] = useState<StatusState | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const matches = (state: ReadScope | null) =>
    state !== null && state.turnId === canonicalTurnId && state.client === lifecycleClient;

  useEffect(() => {
    if (!canonicalTurnId || !shouldFollow) return;
    const controller = new AbortController();
    const scope = { turnId: canonicalTurnId, client: lifecycleClient };
    void followConversationLifecycleProjection({
      turnId: canonicalTurnId,
      lifecycleClient,
      signal: controller.signal,
      onProjection: (projection) => {
        if (controller.signal.aborted) return;
        setProjectionState((current) => ({
          ...scope,
          projection: mergeLifecycleProjections(
            {},
            current?.turnId === canonicalTurnId && current.client === lifecycleClient
              ? { [canonicalTurnId]: current.projection } : {},
            projection,
          )[canonicalTurnId]!,
        }));
      },
      onStatus: (status) => {
        if (controller.signal.aborted) return;
        if (status === "replaying") setErrorState(null);
        setStatusState(status ? { ...scope, status } : null);
      },
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setErrorState({
        ...scope,
        message: error instanceof Error ? error.message : String(error),
      });
      setStatusState({ ...scope, status: "stopped" });
    });
    return () => controller.abort();
  }, [canonicalTurnId, lifecycleClient, revision, shouldFollow]);

  return {
    projection: matches(projectionState) ? projectionState!.projection : emptyProjection,
    isReplayReady: matches(projectionState),
    error: matches(errorState) ? errorState!.message : null,
    continuationStatus: matches(statusState) ? statusState!.status : null,
    retry,
  };
}
