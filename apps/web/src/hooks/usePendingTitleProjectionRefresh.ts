import * as SessionMetadata from "../services/api/sessionMetadata";
import { usePendingTitleProjectionRefresh as useSharedPendingTitleProjectionRefresh } from "@legioncode/client-ui";
import type { AgentSession } from "../types/session";

type ServerSessions = Awaited<ReturnType<typeof SessionMetadata.hydrateSessionsFromServer>>;
interface PendingTitleProjectionRefreshInput {
  enabled: boolean;
  sessions: AgentSession[];
  onServerSessions: (sessions: ServerSessions) => void;
}
const getRecords = (sessions: ServerSessions) => Object.values(sessions);
const onError = (error: unknown) => console.warn(
  "[useSessionManager] Failed to refresh pending title projections:", error,
);

/** Hosted transport binding for the shared bounded canonical projection reader. */
export function usePendingTitleProjectionRefresh(input: PendingTitleProjectionRefreshInput): void {
  useSharedPendingTitleProjectionRefresh({
    enabled: input.enabled,
    records: input.sessions,
    readProjection: SessionMetadata.hydrateSessionsFromServer,
    getRecords,
    onProjection: input.onServerSessions,
    onError,
  });
}
