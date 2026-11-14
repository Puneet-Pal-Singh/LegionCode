import { useMemo } from "react";
import {
  useThreadInputQueue as useSharedThreadInputQueue,
  type ThreadInputQueueActiveTarget,
} from "@legioncode/client-ui";
import type { ConversationScope } from "@legioncode/sdk";
import { createWebPlatformClient } from "../../services/api/platformClient";

/** Web authentication and hosted read scope only; shared UI owns queue delivery. */
export function useThreadInputQueue(
  scope: ConversationScope | null,
  activeTarget: ThreadInputQueueActiveTarget | null,
  invalidationKey: string,
) {
  const client = useMemo(() => createWebPlatformClient(), []);
  const readScope = useMemo(() => scope ? {
    key: `${scope.sessionId}:${scope.runId}:${scope.workspaceId}:${scope.threadId}`,
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
  } : null, [scope]);
  return useSharedThreadInputQueue(readScope, activeTarget, invalidationKey, client);
}
