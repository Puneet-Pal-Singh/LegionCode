import { useMemo } from "react";
import { SessionStateService } from "../services/SessionStateService";

/** Setup owns a preference address, never a persisted execution identity. */
export function useSetupPreferenceScope(
  userId: string | undefined,
  workspaceId: string | null | undefined,
  sessionCount: number,
) {
  return useMemo(() => {
    if (!userId || !workspaceId || sessionCount > 0) return null;
    return SessionStateService.loadOrCreateSetupSession({ userId, workspaceId });
  }, [userId, workspaceId, sessionCount]);
}
