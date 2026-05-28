import { useCallback, useEffect, useState } from "react";
import { SessionStateService } from "../services/SessionStateService";
import type { AgentSession } from "../types/session";

export function useArchivedSessions(isEnabled: boolean): {
  sessions: AgentSession[];
  isLoading: boolean;
  error: string | null;
  removeSession: (sessionId: string) => void;
  refresh: () => Promise<void>;
} {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      setSessions(
        await SessionStateService.hydrateArchivedSessionsFromServer(),
      );
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Failed to load archived chats",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isEnabled) {
      void refresh();
    }
  }, [isEnabled, refresh]);

  const removeSession = useCallback((sessionId: string): void => {
    setSessions((current) =>
      current.filter((session) => session.id !== sessionId),
    );
  }, []);

  return { sessions, isLoading, error, removeSession, refresh };
}
