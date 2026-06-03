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
export type SessionHydrationStatus = "idle" | "loading" | "ready" | "failed";

interface UseSessionManagerOptions {
  hydrateFromServer?: boolean;
}

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
  return keys.some(
    (key) => updates[key] !== undefined && session[key] !== updates[key],
  );
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
  serverRepositories: Array<string | null>,
): string[] {
  const normalizedServerRepositories = serverRepositories.filter(
    (repository): repository is string =>
      repository !== null && repository.trim().length > 0,
  );
  return Array.from(
    new Set([...currentRepositories, ...normalizedServerRepositories]),
  );
}

function replaceSessionById(
  sessions: AgentSession[],
  updatedSession: AgentSession,
): AgentSession[] {
  return sessions.map((session) =>
    session.id === updatedSession.id ? updatedSession : session,
  );
}

function findNextVisibleSession(
  sessions: AgentSession[],
  archivedSessionId: string,
): AgentSession | null {
  return (
    sessions
      .filter((session) => session.id !== archivedSessionId)
      .filter((session) => session.archivedAt === null)
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      )[0] ?? null
  );
}

export function useSessionManager(options: UseSessionManagerOptions = {}) {
  const hydrateFromServer = options.hydrateFromServer ?? true;
  const [sessions, setSessions] = useState<AgentSession[]>(() => {
    const sessionsMap = SessionStateService.loadSessions();
    return Object.values(sessionsMap);
  });
  const [sessionHydrationStatus, setSessionHydrationStatus] =
    useState<SessionHydrationStatus>(() =>
      hydrateFromServer ? "loading" : "idle",
    );
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

  useEffect(() => {
    let cancelled = false;

    async function hydrateServerSessions(): Promise<void> {
      if (!hydrateFromServer) {
        setSessionHydrationStatus("idle");
        return;
      }

      setSessionHydrationStatus("loading");
      try {
        const serverSessions =
          await SessionStateService.hydrateSessionsFromServer();
        const serverSessionList = Object.values(serverSessions);
        if (cancelled) {
          return;
        }

        if (serverSessionList.length > 0) {
          setSessions((current) => mergeSessions(current, serverSessionList));
          setRepositories((current) =>
            mergeRepositories(
              current,
              serverSessionList.map((session) => session.repository),
            ),
          );
          if (!activeSessionIdRef.current) {
            setActiveSessionId(serverSessionList[0]?.id ?? null);
          }
        }
        setSessionHydrationStatus("ready");
      } catch (error) {
        console.warn("[useSessionManager] Failed to hydrate sessions:", error);
        if (!cancelled) {
          setSessionHydrationStatus("failed");
        }
      }
    }

    void hydrateServerSessions();

    return () => {
      cancelled = true;
    };
  }, [hydrateFromServer]);

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
   * Archive a session so it leaves normal navigation without deleting run state.
   */
  const archiveSession = useCallback(async (id: string) => {
    const previousSessions = sessionsRef.current;
    const archivedAt = new Date().toISOString();
    const optimisticSessions = previousSessions.map((session) =>
      session.id === id
        ? { ...session, pinnedAt: null, archivedAt, updatedAt: archivedAt }
        : session,
    );
    const nextActive = findNextVisibleSession(optimisticSessions, id);

    sessionsRef.current = optimisticSessions;
    setSessions(optimisticSessions);
    if (activeSessionIdRef.current === id) {
      setActiveSessionId(nextActive?.id ?? null);
    }

    try {
      const serverSession = await SessionStateService.archiveSession(id);
      setSessions((current) => {
        const next = replaceSessionById(current, serverSession);
        sessionsRef.current = next;
        return next;
      });
    } catch (error) {
      console.warn("[useSessionManager] Failed to archive session:", error);
      sessionsRef.current = previousSessions;
      setSessions(previousSessions);
      if (activeSessionIdRef.current === nextActive?.id) {
        setActiveSessionId(id);
      }
    }
  }, []);

  const removeSession = useCallback(
    (id: string) => {
      void archiveSession(id);
    },
    [archiveSession],
  );

  const reconcileSessionMutation = useCallback(
    async (
      id: string,
      optimisticUpdate: (session: AgentSession) => AgentSession,
      persist: () => Promise<AgentSession>,
    ): Promise<void> => {
      const previousSessions = sessionsRef.current;
      const optimisticSessions = previousSessions.map((session) =>
        session.id === id ? optimisticUpdate(session) : session,
      );

      sessionsRef.current = optimisticSessions;
      setSessions(optimisticSessions);

      try {
        const serverSession = await persist();
        if (serverSession.id !== id) {
          throw new Error("Session metadata response id mismatch");
        }
        setSessions((current) => {
          const next = replaceSessionById(current, serverSession);
          sessionsRef.current = next;
          return next;
        });
      } catch (error) {
        console.warn(
          "[useSessionManager] Failed to update session metadata:",
          error,
        );
        sessionsRef.current = previousSessions;
        setSessions(previousSessions);
      }
    },
    [],
  );

  const renameSession = useCallback(
    async (id: string, title: string): Promise<void> => {
      const trimmedTitle = title.trim().slice(0, 80);
      if (!trimmedTitle) {
        return;
      }
      await reconcileSessionMutation(
        id,
        (session) => ({
          ...session,
          name: trimmedTitle,
          titleSource: "user",
          updatedAt: new Date().toISOString(),
        }),
        () => SessionStateService.renameSessionTitle(id, trimmedTitle),
      );
    },
    [reconcileSessionMutation],
  );

  const pinSession = useCallback(
    async (id: string): Promise<void> => {
      await reconcileSessionMutation(
        id,
        (session) => ({
          ...session,
          pinnedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        () => SessionStateService.pinSession(id),
      );
    },
    [reconcileSessionMutation],
  );

  const unpinSession = useCallback(
    async (id: string): Promise<void> => {
      await reconcileSessionMutation(
        id,
        (session) => ({
          ...session,
          pinnedAt: null,
          updatedAt: new Date().toISOString(),
        }),
        () => SessionStateService.unpinSession(id),
      );
    },
    [reconcileSessionMutation],
  );

  const unarchiveSession = useCallback(
    async (id: string): Promise<void> => {
      await reconcileSessionMutation(
        id,
        (session) => ({
          ...session,
          archivedAt: null,
          updatedAt: new Date().toISOString(),
        }),
        () => SessionStateService.unarchiveSession(id),
      );
    },
    [reconcileSessionMutation],
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
            console.warn(
              "[useSessionManager] Invalid session update:",
              id,
              updates,
            );
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
    sessionHydrationStatus,
    repositories,
    setActiveSessionId,
    createSession,
    removeSession,
    renameSession,
    pinSession,
    unpinSession,
    archiveSession,
    unarchiveSession,
    updateSession,
    clearAllSessions,
    addRepository,
    removeRepository,
    renameRepository,
    generateRunId,
  };
}
