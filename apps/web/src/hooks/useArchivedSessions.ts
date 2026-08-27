import { useCallback, useEffect, useState } from "react";
import { SessionStateService } from "../services/SessionStateService";
import type { AgentSession } from "../types/session";

export function useArchivedSessions(isEnabled: boolean): {
  sessions: AgentSession[];
  isLoading: boolean;
  error: string | null;
  removeSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => Promise<void>;
  deleteAllSessions: () => Promise<void>;
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

  const deleteSession = useCallback(
    async (sessionId: string): Promise<void> => {
      setError(null);
      try {
        await SessionStateService.deleteArchivedSession(sessionId);
        removeSession(sessionId);
      } catch (deleteError) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : "Failed to delete archived chat",
        );
        throw deleteError;
      }
    },
    [removeSession],
  );

  const deleteAllSessions = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await Promise.all(
        sessions.map((session) =>
          SessionStateService.deleteArchivedSession(session.id),
        ),
      );
      setSessions([]);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete all archived chats",
      );
      throw deleteError;
    }
  }, [sessions]);

  return {
    sessions,
    isLoading,
    error,
    removeSession,
    deleteSession,
    deleteAllSessions,
    refresh,
  };
}
