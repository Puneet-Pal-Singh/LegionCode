// apps/web/src/hooks/useSessionManager.ts
/**
 * useSessionManager Hook
 *
 * Manages session lifecycle with v2 schema for multi-session isolation.
 * Uses SessionStateService for persistence.
 * Enforces session-scoped storage keys and run ID isolation.
 *
 * @module hooks/useSessionManager
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { DEFAULT_RUN_MODE, type RunMode } from "@repo/shared-types";
import { agentStore } from "../store/agentStore";
import type { AgentSession } from "../types/session";
import { SessionStateService } from "../services/SessionStateService";

export type { AgentSession } from "../types/session";

function createSessionsMap(
  sessions: AgentSession[],
): Record<string, AgentSession> {
  return Object.fromEntries(sessions.map((session) => [session.id, session]));
}

function hasSessionUpdates(
  session: AgentSession,
  updates: Partial<Omit<AgentSession, "id">>,
): boolean {
  const keys = Object.keys(updates) as Array<keyof Omit<AgentSession, "id">>;
  return keys.some((key) => updates[key] !== undefined && session[key] !== updates[key]);
}

function mergeSessions(
  localSessions: AgentSession[],
  serverSessions: AgentSession[],
): AgentSession[] {
  const merged = new Map<string, AgentSession>();
  for (const session of localSessions) {
    merged.set(session.id, session);
  }
  for (const session of serverSessions) {
    merged.set(session.id, session);
  }
  return Array.from(merged.values()).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function mergeRepositories(
  currentRepositories: string[],
  serverRepositories: string[],
): string[] {
  return Array.from(new Set([...currentRepositories, ...serverRepositories]));
}

export function useSessionManager() {
  const [sessions, setSessions] = useState<AgentSession[]>(() => {
    const sessionsMap = SessionStateService.loadSessions();
    return Object.values(sessionsMap);
  });
  const sessionsRef = useRef<AgentSession[]>(sessions);
  const activeSessionIdRef = useRef<string | null>(null);

  // Persist activeSessionId to survive refreshes
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    const savedId = SessionStateService.loadActiveSessionId();
    if (!savedId) return null;

    // Validate session exists
    const sessions = SessionStateService.loadSessions();
    return sessions[savedId] ? savedId : null;
  });

  // Persist sessions and active ID to localStorage with v2 schema
  useEffect(() => {
    sessionsRef.current = sessions;
    activeSessionIdRef.current = activeSessionId;
    const sessionsMap = createSessionsMap(sessions);
    // Pass activeSessionId to avoid race condition between load and save
    SessionStateService.saveSessions(sessionsMap, activeSessionId);
    SessionStateService.saveActiveSessionId(activeSessionId, sessionsMap);
  }, [activeSessionId, sessions]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateServerSessions(): Promise<void> {
      try {
        const serverSessions = await SessionStateService.hydrateSessionsFromServer();
        const serverSessionList = Object.values(serverSessions);
        if (cancelled || serverSessionList.length === 0) {
          return;
        }

        setSessions((current) => mergeSessions(current, serverSessionList));
        setRepositories((current) =>
          mergeRepositories(current, serverSessionList.map((session) => session.repository)),
        );
        if (!activeSessionIdRef.current) {
          setActiveSessionId(serverSessionList[0]?.id ?? null);
        }
      } catch (error) {
        console.warn("[useSessionManager] Failed to hydrate sessions:", error);
      }
    }

    void hydrateServerSessions();

    return () => {
      cancelled = true;
    };
  }, []);

  const [repositories, setRepositories] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("shadowbox_repositories");
      const parsed = saved ? JSON.parse(saved) : [];

      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(
      "shadowbox_repositories",
      JSON.stringify(repositories),
    );
  }, [repositories]);

  /**
   * Create a new session with v2 schema
   * Generates initial active run ID
   */
  const createSession = useCallback(
    (
      name?: string,
      repository: string = "New Project",
      mode: RunMode = DEFAULT_RUN_MODE,
    ) => {
      const sessionName = typeof name === "string" ? name : `New Task`;

      // Ensure repository exists in the list
      setRepositories((prev) => {
        if (!prev.includes(repository)) {
          return [...prev, repository];
        }
        return prev;
      });

      // Use SessionStateService to create session with proper structure
      const newSession = SessionStateService.createSession(
        sessionName,
        repository,
        "idle",
        mode,
      );

      const nextSessions = [...sessionsRef.current, newSession];
      const sessionsMap = createSessionsMap(nextSessions);

      SessionStateService.saveSessions(sessionsMap, newSession.id);
      SessionStateService.saveActiveSessionId(newSession.id, sessionsMap);
      void SessionStateService.persistSession(newSession).catch((error) => {
        console.warn("[useSessionManager] Failed to persist session:", error);
      });

      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      setActiveSessionId(newSession.id);
      return newSession.id;
    },
    [],
  );

  /**
   * Generate a new UUID v4 run ID for execution
   * Note: Most use cases should use session.activeRunId instead
   */
  const generateRunId = useCallback(() => {
    return crypto.randomUUID();
  }, []);

  const addRepository = useCallback((repository: string) => {
    setRepositories((prev) => {
      if (!prev.includes(repository)) {
        return [...prev, repository];
      }
      return prev;
    });
  }, []);

  const removeRepository = useCallback(
    (repository: string) => {
      setRepositories((prev) => prev.filter((r) => r !== repository));
      // When removing a repo folder, also remove all its tasks to ensure clean state
      setSessions((prev) => {
        const sessionsToRemove = prev.filter(
          (s) => s.repository === repository,
        );
        sessionsToRemove.forEach((s) => {
          // Clear all runs for this session
          for (const runId of s.runIds) {
            agentStore.clearMessages(runId);
          }
        });
        const remaining = prev.filter((s) => s.repository !== repository);

        // If active session was in this repo, clear active ID
        if (
          activeSessionId &&
          sessionsToRemove.some((s) => s.id === activeSessionId)
        ) {
          setActiveSessionId(null);
        }

        return remaining;
      });
    },
    [activeSessionId],
  );

  const renameRepository = useCallback((oldName: string, newName: string) => {
    setRepositories((prev) => prev.map((r) => (r === oldName ? newName : r)));
    setSessions((prev) =>
      prev.map((s) =>
        s.repository === oldName ? { ...s, repository: newName } : s,
      ),
    );
  }, []);

  /**
   * Remove a session and clean up its state
   * Clears all runs associated with the session
   * Clears GitHub context and pending query
   */
  const removeSession = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const sessionToRemove = prev.find((s) => s.id === id);
        if (sessionToRemove) {
          // Clear all runs for this session
          for (const runId of sessionToRemove.runIds) {
            agentStore.clearMessages(runId);
          }
          // Clear session-scoped storage
          SessionStateService.clearSessionGitHubContext(id);
          SessionStateService.clearSessionPendingQuery(id);
        }
        return prev.filter((s) => s.id !== id);
      });
      if (activeSessionId === id) setActiveSessionId(null);
    },
    [activeSessionId],
  );

  /**
   * Update session metadata
   * Validates updates and maintains timestamps
   * Prevents accidental corruption by disallowing id overwrites
   */
  const updateSession = useCallback(
    (id: string, updates: Partial<Omit<AgentSession, "id">>) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          if (!hasSessionUpdates(s, updates)) {
            return s;
          }
          // Merge updates and refresh updatedAt only when values actually changed
          const updated: AgentSession = {
            ...s,
            ...updates,
            id: s.id, // Preserve original id
            updatedAt: new Date().toISOString(),
          };
          // Validate session invariants
          if (!SessionStateService.validateSession(updated)) {
            console.warn("[useSessionManager] Invalid session update:", id, updates);
            return s;
          }
          return updated;
        }),
      );
    },
    [],
  );

  /**
   * Clear all sessions and clean up storage
   * Used during logout or factory reset
   * Clears both session records and per-session scoped storage
   */
  const clearAllSessions = useCallback(() => {
    // Clear per-session scoped storage before clearing main session store
    // Prevents orphaned keys: shadowbox:session-context:{id}, shadowbox:pending-query:{id}
    sessions.forEach((session) => {
      SessionStateService.clearSessionGitHubContext(session.id);
      SessionStateService.clearSessionPendingQuery(session.id);
      // Clear all message runs for this session
      for (const runId of session.runIds) {
        agentStore.clearMessages(runId);
      }
    });

    // Clear main session state
    setSessions([]);
    setActiveSessionId(null);
    setRepositories([]);
    agentStore.clearAllMessages();

    // Clear v2 schema storage
    SessionStateService.saveSessions({}, null);
    SessionStateService.saveActiveSessionId(null, {});

    localStorage.removeItem("shadowbox_repositories");
  }, [sessions]);

  return {
    sessions,
    activeSessionId,
    repositories,
    setActiveSessionId,
    createSession,
    removeSession,
    updateSession,
    clearAllSessions,
    addRepository,
    removeRepository,
    renameRepository,
    generateRunId,
  };
}
