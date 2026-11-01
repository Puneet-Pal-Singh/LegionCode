import * as SessionMetadata from "../services/api/sessionMetadata";
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
import type { HostedSessionWorkspaceContext } from "@legioncode/sdk";
import type { AgentSession } from "../types/session";
import { SessionStateService } from "../services/SessionStateService";
import { createRunId, isCanonicalRunId } from "../lib/run-id";
import { mergeServerSessionProjection } from "./session-title-ordering";
import { usePendingTitleProjectionRefresh } from "./usePendingTitleProjectionRefresh";
import {
  loadRepositoryFolderPreferences,
  setRepositoryFolderHidden,
  setRepositoryFolderLabel,
  type RepositoryFolderPreferences,
} from "../lib/repository-folder-preferences";

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

function sortSessions(sessions: AgentSession[]): AgentSession[] {
  return [...sessions].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function resolveActiveSessionId(
  activeSessionId: string | null,
  sessions: AgentSession[],
): string | null {
  if (sessions.some((session) => session.id === activeSessionId)) {
    return activeSessionId;
  }
  return sessions[0]?.id ?? null;
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
    session.id === updatedSession.id
      ? mergeProjectionIfChanged(session, updatedSession)
      : session,
  );
}

function reconcileSessionPersistence(
  sessions: AgentSession[],
  sessionId: string,
  persisted: AgentSession | null,
  persistenceStatus: NonNullable<AgentSession["persistenceStatus"]>,
): AgentSession[] {
  const current = sessions.find((session) => session.id === sessionId);
  if (!current) return sessions;
  const next = persisted
    ? { ...persisted, ...current, persistenceStatus }
    : { ...current, persistenceStatus };
  return replaceSessionById(sessions, next);
}

function mergeProjectionIfChanged(
  current: AgentSession,
  incoming: AgentSession,
): AgentSession {
  const merged = mergeServerSessionProjection(current, incoming);
  const keys = Object.keys(current) as Array<keyof AgentSession>;
  const unchanged =
    keys.length === Object.keys(merged).length &&
    keys.every((key) => {
      const currentValue = current[key];
      const mergedValue = merged[key];
      if (Array.isArray(currentValue) && Array.isArray(mergedValue)) {
        return (
          currentValue.length === mergedValue.length &&
          currentValue.every((value, index) => value === mergedValue[index])
        );
      }
      return currentValue === mergedValue;
    });
  return unchanged ? current : merged;
}

function parseIsoTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function mergeHydratedSessions(
  serverSessions: AgentSession[],
  currentSessions: AgentSession[],
): AgentSession[] {
  const merged = new Map<string, AgentSession>();
  serverSessions.forEach((session) => merged.set(session.id, session));
  currentSessions.forEach((session) => {
    const serverSession = merged.get(session.id);
    if (!serverSession) {
      merged.set(session.id, session);
      return;
    }
    merged.set(
      session.id,
      mergeServerSessionProjection(session, serverSession),
    );
  });
  return sortSessions(Array.from(merged.values()));
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

interface HydrationSessionCreationWindow {
  confirmedSessionIds: Set<string>;
}

export function useSessionManager(options: UseSessionManagerOptions = {}) {
  const hydrateFromServer = options.hydrateFromServer ?? true;
  const [pendingActiveSessionId] = useState(() =>
    SessionStateService.loadActiveSessionId(),
  );
  const [sessions, setSessions] = useState<AgentSession[]>(() => {
    return [];
  });
  const [sessionHydrationStatus, setSessionHydrationStatus] =
    useState<SessionHydrationStatus>(() =>
      hydrateFromServer ? "loading" : "idle",
    );
  const sessionsRef = useRef<AgentSession[]>(sessions);
  const hydrationCreationWindowRef =
    useRef<HydrationSessionCreationWindow | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeSelectionChangedRef = useRef(false);
  const localMutationVersionRef = useRef(0);
  const sessionProjectionRefreshRef = useRef<Promise<void> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Persist activeSessionId to survive refreshes
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // The v3 session snapshot is a read-only recovery cache. Persist only the
  // per-tab selection after the server has supplied its owned session list.
  useEffect(() => {
    const sessionsMap = createSessionsMap(sessions);
    const refActiveSessionId = activeSessionIdRef.current;
    const effectiveActiveSessionId =
      refActiveSessionId && sessionsMap[refActiveSessionId]
        ? refActiveSessionId
        : activeSessionId;

    sessionsRef.current = sessions;
    if (sessionHydrationStatus !== "ready") return;
    activeSessionIdRef.current = effectiveActiveSessionId;
    SessionStateService.saveActiveSessionId(
      effectiveActiveSessionId,
      sessionsMap,
    );
  }, [activeSessionId, sessions, sessionHydrationStatus]);

  const selectActiveSession = useCallback((sessionId: string | null): void => {
    activeSessionIdRef.current = sessionId;
    activeSelectionChangedRef.current = true;
    if (sessionHydrationStatus !== "ready") return;
    localMutationVersionRef.current += 1;
    setActiveSessionId(sessionId);
  }, [sessionHydrationStatus]);

  const [repositories, setRepositories] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("legioncode_repositories");
      const parsed = saved ? JSON.parse(saved) : [];

      if (Array.isArray(parsed)) {
        return parsed.filter(
          (repository): repository is string => typeof repository === "string",
        );
      }
      return [];
    } catch {
      return [];
    }
  });
  const repositoriesRef = useRef(repositories);
  const [repositoryFolderPreferences, setRepositoryFolderPreferences] =
    useState<RepositoryFolderPreferences>(loadRepositoryFolderPreferences);
  const rememberRepository = useCallback((repository: string) => {
    if (repositoriesRef.current.includes(repository)) return;
    const next = [...repositoriesRef.current, repository];
    repositoriesRef.current = next;
    setRepositories(next);
    try {
      localStorage.setItem("legioncode_repositories", JSON.stringify(next));
    } catch {
      // Repository discovery remains available from the canonical session list.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let hydrationCreationWindow: HydrationSessionCreationWindow | null = null;

    async function hydrateServerSessions(): Promise<void> {
      if (!hydrateFromServer) {
        setSessionHydrationStatus("idle");
        return;
      }

      setSessionHydrationStatus("loading");
      const currentHydrationCreationWindow: HydrationSessionCreationWindow = {
        confirmedSessionIds: new Set(),
      };
      hydrationCreationWindow = currentHydrationCreationWindow;
      hydrationCreationWindowRef.current = currentHydrationCreationWindow;
      const hydrationVersion = localMutationVersionRef.current;
      try {
        const serverSessions =
          await SessionMetadata.hydrateSessionsFromServer();
        if (cancelled) {
          return;
        }
        const serverSessionList = sortSessions(Object.values(serverSessions));
        const hasLocalMutation =
          localMutationVersionRef.current !== hydrationVersion;
        const sessionsCreatedDuringHydration = sessionsRef.current.filter(
          (session) =>
            currentHydrationCreationWindow.confirmedSessionIds.has(session.id),
        );
        const nextSessions = hasLocalMutation
          ? mergeHydratedSessions(
              serverSessionList,
              sessionsCreatedDuringHydration,
            )
          : serverSessionList;

        const requestedActiveSessionId =
          activeSelectionChangedRef.current || hasLocalMutation
            ? activeSessionIdRef.current
            : pendingActiveSessionId;
        const nextActiveSessionId = resolveActiveSessionId(
          requestedActiveSessionId,
          nextSessions,
        );
        sessionsRef.current = nextSessions;
        activeSessionIdRef.current = nextActiveSessionId;
        setSessions(nextSessions);
        setActiveSessionId(nextActiveSessionId);

        if (nextSessions.length > 0) {
          setRepositories((current) => {
            const next = mergeRepositories(
              current,
              nextSessions.map((session) => session.repository),
            );
            repositoriesRef.current = next;
            return next;
          });
        }
        if (
          hydrationCreationWindowRef.current === currentHydrationCreationWindow
        ) {
          hydrationCreationWindowRef.current = null;
        }
        setSessionHydrationStatus("ready");
      } catch (error) {
        console.warn("[useSessionManager] Failed to hydrate sessions:", error);
        if (!cancelled) {
          const sessionsCreatedDuringHydration = sessionsRef.current.filter(
            (session) =>
              currentHydrationCreationWindow.confirmedSessionIds.has(
                session.id,
              ),
          );
          const createdSessionIds = new Set(
            sessionsCreatedDuringHydration.map((session) => session.id),
          );
          const activeCreatedSessionId = activeSessionIdRef.current &&
            createdSessionIds.has(activeSessionIdRef.current)
            ? activeSessionIdRef.current
            : null;
          sessionsRef.current = sessionsCreatedDuringHydration;
          activeSessionIdRef.current = activeCreatedSessionId;
          setSessions(sessionsCreatedDuringHydration);
          setActiveSessionId(activeCreatedSessionId);
          if (
            hydrationCreationWindowRef.current === currentHydrationCreationWindow
          ) {
            hydrationCreationWindowRef.current = null;
          }
          setSessionHydrationStatus("failed");
        }
      }
    }

    void hydrateServerSessions();

    return () => {
      cancelled = true;
      if (
        hydrationCreationWindow &&
        hydrationCreationWindowRef.current === hydrationCreationWindow
      ) {
        hydrationCreationWindowRef.current = null;
      }
    };
  }, [hydrateFromServer, pendingActiveSessionId]);

  const mergeTitleServerSessions = useCallback(
    (
      serverSessions: Awaited<
        ReturnType<typeof SessionMetadata.hydrateSessionsFromServer>
      >,
    ) => {
      setSessions((current) => {
        const next = current.map((session) => {
          const serverSession = serverSessions[session.id];
          return serverSession
            ? mergeProjectionIfChanged(session, serverSession)
            : session;
        });
        if (next.every((session, index) => session === current[index]))
          return current;
        sessionsRef.current = next;
        return next;
      });
    },
    [],
  );
  usePendingTitleProjectionRefresh({
    enabled: hydrateFromServer && sessionHydrationStatus === "ready",
    sessions,
    onServerSessions: mergeTitleServerSessions,
  });

  const refreshSessionProjections = useCallback(async (): Promise<void> => {
    if (sessionProjectionRefreshRef.current) {
      return await sessionProjectionRefreshRef.current;
    }
    const refresh = (async () => {
      const serverSessions =
        await SessionMetadata.hydrateSessionsFromServer();
      if (!isMountedRef.current) return;
      setSessions((current) => {
        const next = current.map((session) => {
          const serverSession = serverSessions[session.id];
          return serverSession
            ? mergeProjectionIfChanged(session, serverSession)
            : session;
        });
        if (next.every((session, index) => session === current[index])) {
          return current;
        }
        sessionsRef.current = next;
        return next;
      });
    })();
    sessionProjectionRefreshRef.current = refresh;
    try {
      await refresh;
    } finally {
      sessionProjectionRefreshRef.current = null;
    }
  }, []);

  const activeProjectionKey = sessions
    .filter(
      (session) =>
        session.status === "running" ||
        session.status === "waiting_for_approval",
    )
    .map((session) => session.id)
    .sort()
    .join("|");

  useEffect(() => {
    if (!hydrateFromServer || sessionHydrationStatus !== "ready") return;

    let cancelled = false;
    let timeout: number | undefined;
    const schedulePoll = (): void => {
      if (
        cancelled ||
        activeProjectionKey.length === 0 ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => void poll(), 2_000);
    };
    const refreshIfVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      void refreshSessionProjections()
        .catch((error) => {
          console.warn(
            "[useSessionManager] Failed to refresh session projections:",
            error,
          );
        })
        .finally(schedulePoll);
    };
    const poll = async (): Promise<void> => {
      if (
        cancelled ||
        activeProjectionKey.length === 0 ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      try {
        await refreshSessionProjections();
      } catch (error) {
        console.warn(
          "[useSessionManager] Failed to refresh active session projections:",
          error,
        );
      }
      schedulePoll();
    };

    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    if (activeProjectionKey.length > 0) {
      schedulePoll();
    }
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [
    activeProjectionKey,
    hydrateFromServer,
    refreshSessionProjections,
    sessionHydrationStatus,
  ]);

  /**
   * Create a new session with v2 schema
   * Generates initial active run ID
   */
  const createSession = useCallback(
    async (
      name?: string,
      repository: string = "New Project",
      mode: RunMode = DEFAULT_RUN_MODE,
      workspaceId?: string,
    ) => {
      const sessionName = typeof name === "string" ? name : `New Task`;

      // Use SessionStateService to create session with proper structure
      const newSession = SessionStateService.createSession(
        sessionName,
        repository,
        "idle",
        mode,
      );
      if (workspaceId) newSession.workspaceId = workspaceId;

      // Admission requires the owned conversation to exist before it is visible
      // to setup/submit callers. A failed create must not publish a local session.
      const activeHydrationWindow = hydrationCreationWindowRef.current;
      const confirmedSession = await SessionMetadata.persistSession(newSession);
      if (
        confirmedSession.id !== newSession.id ||
        confirmedSession.activeRunId !== newSession.activeRunId ||
        (confirmedSession.workspaceId ?? null) !== (newSession.workspaceId ?? null) ||
        confirmedSession.repository !== newSession.repository ||
        confirmedSession.mode !== newSession.mode ||
        !SessionStateService.validateSession(confirmedSession)
      ) {
        throw new Error("Session creation response did not match the request");
      }
      rememberRepository(repository);
      setRepositoryFolderPreferences(setRepositoryFolderHidden(repository, false));
      if (
        activeHydrationWindow &&
        hydrationCreationWindowRef.current === activeHydrationWindow
      ) {
        activeHydrationWindow.confirmedSessionIds.add(newSession.id);
      }
      const nextSessions = [
        ...sessionsRef.current,
        confirmedSession,
      ];
      const sessionsMap = createSessionsMap(nextSessions);

      SessionStateService.saveActiveSessionId(newSession.id, sessionsMap);

      sessionsRef.current = nextSessions;
      activeSessionIdRef.current = newSession.id;
      localMutationVersionRef.current += 1;
      setSessions(nextSessions);
      setActiveSessionId(newSession.id);
      return confirmedSession.id;
    },
    [rememberRepository],
  );

  const retrySessionPersistence = useCallback(
    async (id: string): Promise<void> => {
      const current = sessionsRef.current.find((session) => session.id === id);
      if (!current || current.persistenceStatus !== "failed") return;
      const savingSession = {
        ...current,
        persistenceStatus: "saving" as const,
      };
      let next = replaceSessionById(sessionsRef.current, savingSession);
      sessionsRef.current = next;
      setSessions(next);
      try {
        const serverSession =
          await SessionMetadata.persistSession(savingSession);
        next = reconcileSessionPersistence(
          sessionsRef.current,
          id,
          serverSession,
          "saved",
        );
      } catch (error) {
        console.warn("[useSessionManager] Session retry failed:", error);
        next = reconcileSessionPersistence(
          sessionsRef.current,
          id,
          null,
          "failed",
        );
      }
      sessionsRef.current = next;
      setSessions(next);
    },
    [],
  );

  /**
   * Generate a canonical run ID for execution.
   * Note: Most use cases should use session.activeRunId instead
   */
  const generateRunId = useCallback(() => {
    return createRunId();
  }, []);

  const addRepository = useCallback((repository: string) => {
    rememberRepository(repository);
    setRepositoryFolderPreferences(setRepositoryFolderHidden(repository, false));
  }, [rememberRepository]);

  const removeRepository = useCallback((repository: string) => {
    setRepositoryFolderPreferences(setRepositoryFolderHidden(repository, true));
  }, []);

  const renameRepository = useCallback((repositoryId: string, label: string) => {
    setRepositoryFolderPreferences(setRepositoryFolderLabel(repositoryId, label));
  }, []);

  /**
   * Archive a session so it leaves normal navigation without deleting run state.
   */
  const archiveSession = useCallback(async (id: string): Promise<boolean> => {
    const previousSessions = sessionsRef.current;
    const previousSession = previousSessions.find((session) => session.id === id);
    if (!previousSession) return false;
    const activeSessionIdBefore = activeSessionIdRef.current;
    const archivedAt = new Date().toISOString();
    const optimisticSessions = previousSessions.map((session) =>
      session.id === id
        ? { ...session, pinnedAt: null, archivedAt, updatedAt: archivedAt }
        : session,
    );
    const nextActive = findNextVisibleSession(optimisticSessions, id);

    sessionsRef.current = optimisticSessions;
    setSessions(optimisticSessions);
    if (activeSessionIdBefore === id) {
      activeSessionIdRef.current = nextActive?.id ?? null;
      activeSelectionChangedRef.current = true;
      localMutationVersionRef.current += 1;
      setActiveSessionId(nextActive?.id ?? null);
    }

    try {
      const serverSession = await SessionMetadata.archiveSession(id);
      if (serverSession.id !== id) {
        throw new Error("Session archive response id mismatch");
      }
      setSessions((current) => {
        const next = replaceSessionById(current, serverSession);
        sessionsRef.current = next;
        return next;
      });
      return true;
    } catch (error) {
      console.warn("[useSessionManager] Failed to archive session:", error);
      const rolledBackSessions = sessionsRef.current.map((session) =>
        session.id === id ? previousSession : session,
      );
      sessionsRef.current = rolledBackSessions;
      setSessions(rolledBackSessions);
      if (
        activeSessionIdBefore === id &&
        activeSessionIdRef.current === (nextActive?.id ?? null)
      ) {
        activeSessionIdRef.current = id;
        activeSelectionChangedRef.current = true;
        setActiveSessionId(id);
      }
      return false;
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
        throw new Error("Chat title cannot be empty");
      }
      const serverSession = await SessionMetadata.renameSessionTitle(
        id,
        trimmedTitle,
      );
      if (serverSession.id !== id) {
        throw new Error("Session metadata response id mismatch");
      }
      setSessions((current) => {
        const target = current.find((session) => session.id === id);
        if (!target) return current;
        const mergedTitle = mergeServerSessionProjection(target, serverSession);
        const currentUpdatedAt = parseIsoTimestamp(target.updatedAt);
        const serverUpdatedAt = parseIsoTimestamp(serverSession.updatedAt);
        const updatedTarget: AgentSession = {
          ...target,
          name: mergedTitle.name,
          titleSource: mergedTitle.titleSource,
          titleVersion: mergedTitle.titleVersion,
          titleStatus: mergedTitle.titleStatus,
          updatedAt:
            serverUpdatedAt !== null &&
            (currentUpdatedAt === null || serverUpdatedAt > currentUpdatedAt)
              ? serverSession.updatedAt
              : target.updatedAt,
        };
        const next = current.map((session) =>
          session.id === id ? updatedTarget : session,
        );
        sessionsRef.current = next;
        return next;
      });
    },
    [],
  );

  const refreshSessionProjection = useCallback(
    async (id: string): Promise<void> => {
      try {
        const serverSessions =
          await SessionMetadata.hydrateSessionsFromServer();
        const serverSession = serverSessions[id];
        if (!serverSession) {
          return;
        }
        setSessions((current) => {
          const next = replaceSessionById(current, serverSession);
          sessionsRef.current = next;
          return next;
        });
      } catch (error) {
        console.warn(
          "[useSessionManager] Failed to refresh session projection:",
          error,
        );
      }
    },
    [],
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
        () => SessionMetadata.pinSession(id),
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
        () => SessionMetadata.unpinSession(id),
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
        () => SessionMetadata.unarchiveSession(id),
      );
    },
    [reconcileSessionMutation],
  );

  const acknowledgeSession = useCallback(async (id: string): Promise<void> => {
    const session = sessionsRef.current.find(
      (candidate) => candidate.id === id,
    );
    const terminalTurnId = session?.lastTerminalTurnId;
    if (
      !terminalTurnId ||
      terminalTurnId === session?.lastAcknowledgedTerminalTurnId
    ) {
      return;
    }

    const previousAcknowledgedTurnId =
      session.lastAcknowledgedTerminalTurnId ?? null;
    const updateAcknowledgement = (
      current: AgentSession,
      acknowledgedTurnId: string | null,
    ): AgentSession => ({
      ...current,
      lastAcknowledgedTerminalTurnId: acknowledgedTurnId,
    });

    // A read receipt is not thread activity. Keep title ordering metadata
    // untouched while optimistically clearing the unread marker.
    setSessions((current) => {
      const next = current.map((candidate) =>
        candidate.id === id && candidate.lastTerminalTurnId === terminalTurnId
          ? updateAcknowledgement(candidate, terminalTurnId)
          : candidate,
      );
      sessionsRef.current = next;
      return next;
    });

    try {
      const serverReceipt = await SessionMetadata.acknowledgeSessionReadReceipt(
        id,
        terminalTurnId,
      );
      if (serverReceipt.sessionId !== id) {
        throw new Error("Session read receipt response id mismatch");
      }
      if (serverReceipt.lastAcknowledgedTerminalTurnId !== terminalTurnId) {
        throw new Error("Session read receipt response turn mismatch");
      }
      setSessions((current) => {
        const next = current.map((candidate) =>
          candidate.id === id &&
          candidate.lastTerminalTurnId === terminalTurnId
            ? updateAcknowledgement(candidate, serverReceipt.lastAcknowledgedTerminalTurnId)
            : candidate,
        );
        sessionsRef.current = next;
        return next;
      });
    } catch (error) {
      console.warn("[useSessionManager] Failed to acknowledge session:", error);
      setSessions((current) => {
        const next = current.map((candidate) =>
          candidate.id === id &&
          candidate.lastAcknowledgedTerminalTurnId === terminalTurnId
            ? updateAcknowledgement(candidate, previousAcknowledgedTurnId)
            : candidate,
        );
        sessionsRef.current = next;
        return next;
      });
    }
  }, []);

  const applySessionProjection = useCallback(
    (id: string, project: (session: AgentSession) => AgentSession) => {
      const current = sessionsRef.current.find((session) => session.id === id);
      if (!current) return;
      const updated = project(current);
      if (updated === current) return;
      if (!SessionStateService.validateSession(updated)) {
        console.warn("[useSessionManager] Rejected invalid session projection:", id);
        return;
      }
      const next = sessionsRef.current.map((session) =>
        session.id === id ? updated : session,
      );
      sessionsRef.current = next;
      setSessions(next);
    },
    [],
  );

  const setSessionMode = useCallback(
    (id: string, mode: RunMode) => {
      applySessionProjection(id, (session) =>
        session.mode === mode ? session : { ...session, mode },
      );
    },
    [applySessionProjection],
  );

  const recordSessionRun = useCallback(
    (id: string, runId: string) => {
      if (!isCanonicalRunId(runId)) return;
      applySessionProjection(id, (session) => {
        if (session.activeRunId === runId && session.latestRunId === runId) {
          return session;
        }
        return {
          ...session,
          activeRunId: runId,
          latestRunId: runId,
          runIds: Array.from(new Set([...session.runIds, runId])),
        };
      });
    },
    [applySessionProjection],
  );

  const applyCanonicalSessionStatus = useCallback(
    (id: string, runId: string, status: AgentSession["status"]) => {
      if (!isCanonicalRunId(runId)) return;
      applySessionProjection(id, (session) => {
        if (
          session.activeRunId !== runId &&
          !(session.activeRunId === null && session.latestRunId === runId)
        ) {
          return session;
        }
        return session.status === status ? session : { ...session, status };
      });
    },
    [applySessionProjection],
  );

  const applySessionWorkspaceProjection = useCallback(
    (
      id: string,
      projection: Pick<
        HostedSessionWorkspaceContext,
        "sessionId" | "workspaceId" | "threadId"
      >,
    ) => {
      if (projection.sessionId !== id) return;
      applySessionProjection(id, (session) => {
        if (
          session.workspaceId === projection.workspaceId &&
          session.threadId === projection.threadId
        ) {
          return session;
        }
        return {
          ...session,
          workspaceId: projection.workspaceId,
          threadId: projection.threadId,
        };
      });
    },
    [applySessionProjection],
  );

  return {
    sessions,
    activeSessionId,
    sessionHydrationStatus,
    repositories,
    repositoryFolderPreferences,
    setActiveSessionId: selectActiveSession,
    createSession,
    retrySessionPersistence,
    removeSession,
    renameSession,
    refreshSessionProjection,
    pinSession,
    unpinSession,
    archiveSession,
    unarchiveSession,
    acknowledgeSession,
    setSessionMode,
    recordSessionRun,
    applyCanonicalSessionStatus,
    applySessionWorkspaceProjection,
    addRepository,
    removeRepository,
    renameRepository,
    generateRunId,
  };
}
