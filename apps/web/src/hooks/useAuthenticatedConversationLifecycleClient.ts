import { useMemo } from "react";
import type { PlatformClient } from "@legioncode/sdk";
import { useAuth } from "../contexts/AuthContext";
import { createWebPlatformClient } from "../services/api/platformClient";

type ReplayClient = Pick<PlatformClient, "replayLifecycleEvents">;
type FollowingClient = ReplayClient & Pick<PlatformClient, "followTurnLifecycle">;
interface AuthenticatedClient<TClient> {
  readonly client: TClient;
  readonly hasAuthenticatedOwner: boolean;
}

export function useAuthenticatedConversationLifecycleClient(
  injectedClient?: FollowingClient,
): AuthenticatedClient<FollowingClient>;
export function useAuthenticatedConversationLifecycleClient(
  injectedClient?: ReplayClient,
): AuthenticatedClient<ReplayClient>;
/** Bind read identity to the actual account even when an injected client stays
 * constant. Same-account session refreshes preserve the existing reader. */
export function useAuthenticatedConversationLifecycleClient(
  injectedClient?: ReplayClient & Partial<Pick<PlatformClient, "followTurnLifecycle">>,
) {
  const { user, isAuthenticated } = useAuth();
  const ownerId = isAuthenticated && user ? String(user.id) : null;
  const client = useMemo(() => {
    const source = injectedClient ?? createWebPlatformClient();
    const assertOwner = () => {
      if (ownerId === null) throw new Error("Sign in before reading this task's lifecycle.");
    };
    const replayLifecycleEvents: PlatformClient["replayLifecycleEvents"] = (request, options) => {
      assertOwner();
      return source.replayLifecycleEvents(request, options);
    };
    const follow = source.followTurnLifecycle?.bind(source);
    return Object.freeze({
      replayLifecycleEvents,
      ...(follow ? {
        followTurnLifecycle: (...args: Parameters<PlatformClient["followTurnLifecycle"]>) => {
          assertOwner();
          return follow(...args);
        },
      } : {}),
    });
  }, [injectedClient, ownerId]);
  return { client, hasAuthenticatedOwner: ownerId !== null };
}
