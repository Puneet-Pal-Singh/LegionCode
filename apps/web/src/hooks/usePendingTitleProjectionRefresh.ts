import { useEffect, useMemo, useRef } from "react";
import { SessionStateService } from "../services/SessionStateService";
import type { AgentSession } from "../types/session";

const POLL_INTERVAL_MS = 750;
// Title generation is bounded at 20 seconds in Brain. Keep the projection
// refresh alive slightly longer so a title that settles near that boundary is
// still observed by the client.
const TITLE_GENERATION_SETTLEMENT_WINDOW_MS = 24_000;
const MAX_POLLS = Math.ceil(
  TITLE_GENERATION_SETTLEMENT_WINDOW_MS / POLL_INTERVAL_MS,
);

type ServerSessions = Awaited<
  ReturnType<typeof SessionStateService.hydrateSessionsFromServer>
>;

interface PendingTitleProjectionRefreshInput {
  enabled: boolean;
  sessions: AgentSession[];
  onServerSessions: (sessions: ServerSessions) => void;
}

/**
 * Refreshes the canonical session projection while background title inference
 * is pending. Polling is bounded and never creates or guesses title state.
 */
export function usePendingTitleProjectionRefresh({
  enabled,
  sessions,
  onServerSessions,
}: PendingTitleProjectionRefreshInput): void {
  const pollCountsRef = useRef(new Map<string, number>());
  const pendingKey = useMemo(
    () =>
      sessions
        // `titleSource` and `titleVersion` are the canonical session metadata
        // returned by Brain. `titleStatus` is not persisted and must not be
        // required for refresh eligibility after a reload.
        .filter((session) => session.titleSource === "preview")
        .map((session) => `${session.id}:${session.titleVersion ?? 0}`)
        .sort()
        .join("|"),
    [sessions],
  );

  useEffect(() => {
    if (!enabled || pendingKey.length === 0) return;

    const pendingKeys = pendingKey.split("|");

    let cancelled = false;
    let timeout: number | undefined;
    const schedule = (): void => {
      timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    const poll = async (): Promise<void> => {
      const eligibleKeys = pendingKeys.filter(
        (key) => (pollCountsRef.current.get(key) ?? 0) < MAX_POLLS,
      );
      if (cancelled || eligibleKeys.length === 0) return;

      eligibleKeys.forEach((key) =>
        pollCountsRef.current.set(
          key,
          (pollCountsRef.current.get(key) ?? 0) + 1,
        ),
      );
      try {
        const serverSessions =
          await SessionStateService.hydrateSessionsFromServer();
        if (cancelled) return;
        onServerSessions(serverSessions);
        if (hasPendingProjection(eligibleKeys, serverSessions)) schedule();
      } catch (error) {
        console.warn(
          "[useSessionManager] Failed to refresh pending title projections:",
          error,
        );
        if (!cancelled) schedule();
      }
    };

    schedule();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [enabled, onServerSessions, pendingKey]);
}

function hasPendingProjection(
  keys: string[],
  serverSessions: ServerSessions,
): boolean {
  return keys.some((key) => {
    const [sessionId, version] = key.split(":");
    const serverSession = sessionId ? serverSessions[sessionId] : null;
    if (!serverSession) return true;
    return (
      serverSession.titleSource === "preview" &&
      String(serverSession.titleVersion ?? 0) === version
    );
  });
}
