import { useConversationTurnLifecycle, type ConversationLifecycleClient } from "@legioncode/client-ui";
import { useAuthenticatedConversationLifecycleClient } from "./useAuthenticatedConversationLifecycleClient";

/** Hosted transport binding for the shared SDK lifecycle delivery adapter. */
export function useTurnLifecycleProjection(
  turnId: string | null | undefined,
  shouldFollow: boolean,
  injectedClient?: ConversationLifecycleClient,
) {
  const { client, hasAuthenticatedOwner } = useAuthenticatedConversationLifecycleClient(injectedClient);
  return useConversationTurnLifecycle(turnId, shouldFollow && hasAuthenticatedOwner, client);
}
