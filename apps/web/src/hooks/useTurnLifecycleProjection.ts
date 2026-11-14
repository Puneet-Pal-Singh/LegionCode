import { useMemo } from "react";
import { useConversationTurnLifecycle, type ConversationLifecycleClient } from "@legioncode/client-ui";
import { createWebPlatformClient } from "../services/api/platformClient";

/** Hosted transport binding for the shared SDK lifecycle delivery adapter. */
export function useTurnLifecycleProjection(
  turnId: string | null | undefined,
  shouldFollow: boolean,
  injectedClient?: ConversationLifecycleClient,
) {
  const lifecycleClient = useMemo(
    () => injectedClient ?? createWebPlatformClient(),
    [injectedClient],
  );
  return useConversationTurnLifecycle(turnId, shouldFollow, lifecycleClient);
}
