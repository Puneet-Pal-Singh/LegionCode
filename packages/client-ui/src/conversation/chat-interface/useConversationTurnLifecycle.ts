import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const projectionRef = useRef<ProjectionState | null>(null);
  const currentRead = useRef({ turnId: canonicalTurnId, client: lifecycleClient, shouldFollow });
  currentRead.current = { turnId: canonicalTurnId, client: lifecycleClient, shouldFollow };
  const [errorState, setErrorState] = useState<ErrorState | null>(null);
  const [statusState, setStatusState] = useState<StatusState | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const matches = (state: ReadScope | null) =>
    state !== null && state.turnId === canonicalTurnId && state.client === lifecycleClient;
  const readCurrentProjection = useCallback((): LifecycleProjection | null => {
    const selected = currentRead.current;
    const value = projectionRef.current;
    return selected.shouldFollow && selected.turnId === canonicalTurnId && selected.client === lifecycleClient &&
      value?.turnId === canonicalTurnId && value.client === lifecycleClient ? value.projection : null;
  }, [canonicalTurnId, lifecycleClient]);

  useEffect(() => {
    if (!canonicalTurnId || !shouldFollow) return;
    const controller = new AbortController();
    const scope = { turnId: canonicalTurnId, client: lifecycleClient };
    void followConversationLifecycleProjection({
      turnId: canonicalTurnId,
      lifecycleClient,
      signal: controller.signal,
      onProjection: (projection) => {
        if (controller.signal.aborted || currentRead.current.turnId !== canonicalTurnId ||
            currentRead.current.client !== lifecycleClient || !currentRead.current.shouldFollow) return;
        const current = projectionRef.current;
        const next = {
          ...scope,
          projection: mergeLifecycleProjections(
            {},
            current?.turnId === canonicalTurnId && current.client === lifecycleClient
              ? { [canonicalTurnId]: current.projection } : {},
            projection,
          )[canonicalTurnId]!,
        };
        // Command guards read the same SDK projection before React commits it.
        projectionRef.current = next;
        setProjectionState(next);
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
    readCurrentProjection,
    projection: matches(projectionState) ? projectionState!.projection : emptyProjection,
    isReplayReady: matches(projectionState),
    error: matches(errorState) ? errorState!.message : null,
    continuationStatus: matches(statusState) ? statusState!.status : null,
    retry,
  };
}
