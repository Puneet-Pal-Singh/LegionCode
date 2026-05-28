/**
 * SessionStateService
 *
 * Single Responsibility: Manage session persistence, migrations, and state.
 * Enforces session-scoped storage keys and data model consistency.
 *
 * Storage Keys:
 * - shadowbox:sessions:v3 — Main session store
 * - shadowbox:active-session-id:v3 — Active session selector
 * - shadowbox:session-context:{sessionId} — GitHub context per session
 * - shadowbox:pending-query:{sessionId} — Pending user input per session
 * - shadowbox:run:{runId}:messages — Messages per run
 *
 * @module services/SessionStateService
 */

import { DEFAULT_RUN_MODE, type RunMode } from "@repo/shared-types";
import {
  archivedSessionsPath,
  sessionArchivePath,
  sessionPinPath,
  sessionTitlePath,
  sessionUnarchivePath,
  sessionUnpinPath,
  sessionsPath,
} from "../lib/platform-endpoints";
import type {
  AgentSession,
  ChatTitleSource,
  SessionStatus,
  SessionStorageSchema,
  SessionGitHubContext,
  SetupSessionState,
} from "../types/session";

const SESSIONS_KEY = "shadowbox:sessions:v3";
const ACTIVE_SESSION_ID_KEY = "shadowbox:active-session-id:v3";
const SETUP_SESSION_KEY = "shadowbox:setup-session:v1";

type StoredAgentSession = Omit<AgentSession, "mode"> & {
  mode?: RunMode;
  titleSource?: ChatTitleSource;
  pinnedAt?: string | null;
  archivedAt?: string | null;
};

interface ServerSessionRecord {
  id: string;
  title: string;
  titleSource?: ChatTitleSource;
  repository: string | null;
  activeRunId: string | null;
  mode: RunMode;
  status: "idle" | "running" | "completed" | "failed";
  pinnedAt?: string | null;
  archivedAt?: string | null;
  updatedAt: string;
}

interface ServerSessionsResponse {
  sessions: ServerSessionRecord[];
}

interface ServerSessionResponse {
  session: ServerSessionRecord;
}

function getSessionContextKey(sessionId: string): string {
  return `shadowbox:session-context:${sessionId}`;
}

function getSessionPendingQueryKey(sessionId: string): string {
  return `shadowbox:pending-query:${sessionId}`;
}

/**
 * SessionStateService
 * Centralized persistence layer for multi-session state
 */
export class SessionStateService {
  /**
   * Load all sessions from localStorage
   * Returns empty object if not found or corrupted
   */
  static loadSessions(): Record<string, AgentSession> {
    try {
      const stored = localStorage.getItem(SESSIONS_KEY);
      if (!stored) return {};

      const parsed = JSON.parse(stored) as SessionStorageSchema;

      // Validate version (for future migrations)
      if (parsed.version !== 3) {
        console.warn(
          "[SessionStateService] Unknown version, returning empty sessions",
        );
        return {};
      }

      const sessions = parsed.sessions || {};
      return Object.fromEntries(
        Object.entries(sessions).map(([sessionId, session]) => [
          sessionId,
          normalizeSession(session as StoredAgentSession),
        ]),
      );
    } catch (e) {
      console.error("[SessionStateService] Failed to load sessions:", e);
      return {};
    }
  }

  /**
   * Save all sessions to localStorage
   * Maintains append-only invariant for messages elsewhere
   *
   * Note: Pass activeSessionId explicitly to avoid race conditions
   * where another tab updates the active session between load and save.
   */
  static saveSessions(
    sessions: Record<string, AgentSession>,
    activeSessionId: string | null = null,
  ): void {
    // Use provided activeSessionId or load current value
    // Prefer parameter to avoid race condition
    const currentActiveId =
      activeSessionId !== null ? activeSessionId : this.loadActiveSessionId();

    const schema: SessionStorageSchema = {
      version: 3,
      sessions,
      activeSessionId: currentActiveId,
      lastModified: new Date().toISOString(),
    };

    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(schema));
    } catch (e) {
      console.error("[SessionStateService] Failed to save sessions:", e);
    }
  }

  static async hydrateSessionsFromServer(): Promise<
    Record<string, AgentSession>
  > {
    const response = await fetch(sessionsPath(), { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Session hydration failed: ${response.status}`);
    }

    const payload = (await response.json()) as Partial<ServerSessionsResponse>;
    if (!Array.isArray(payload.sessions)) {
      throw new Error("Invalid session hydration response");
    }

    return Object.fromEntries(
      payload.sessions
        .map(mapServerSession)
        .filter((session): session is AgentSession => session !== null)
        .map((session) => [session.id, session]),
    );
  }

  static async persistSession(session: AgentSession): Promise<AgentSession> {
    const response = await fetch(sessionsPath(), {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: session.id,
        runId: session.activeRunId,
        title: session.name,
        titleSource: session.titleSource,
        repository: session.repository,
        mode: session.mode,
      }),
    });

    if (!response.ok) {
      throw new Error(`Session persistence failed: ${response.status}`);
    }

    return readServerSessionResponse(response);
  }

  static async renameSessionTitle(
    sessionId: string,
    title: string,
  ): Promise<AgentSession> {
    const response = await fetch(sessionTitlePath(sessionId), {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    });

    return readMetadataMutationResponse(response, "Session rename");
  }

  static async pinSession(sessionId: string): Promise<AgentSession> {
    return sendSessionMutation(sessionPinPath(sessionId), "Session pin");
  }

  static async unpinSession(sessionId: string): Promise<AgentSession> {
    return sendSessionMutation(sessionUnpinPath(sessionId), "Session unpin");
  }

  static async archiveSession(sessionId: string): Promise<AgentSession> {
    const response = await fetch(sessionArchivePath(sessionId), {
      method: "POST",
      credentials: "include",
    });

    return readMetadataMutationResponse(response, "Session archive");
  }

  static async unarchiveSession(sessionId: string): Promise<AgentSession> {
    return sendSessionMutation(
      sessionUnarchivePath(sessionId),
      "Session unarchive",
    );
  }

  static async hydrateArchivedSessionsFromServer(): Promise<AgentSession[]> {
    const response = await fetch(archivedSessionsPath(), {
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`Archived session hydration failed: ${response.status}`);
    }
    const payload = (await response.json()) as Partial<ServerSessionsResponse>;
    if (!Array.isArray(payload.sessions)) {
      throw new Error("Invalid archived session hydration response");
    }
    return payload.sessions
      .map(mapServerSession)
      .filter((session): session is AgentSession => session !== null);
  }

  /**
   * Load the currently active session ID
   */
  static loadActiveSessionId(): string | null {
    try {
      const stored = localStorage.getItem(ACTIVE_SESSION_ID_KEY);
      return stored || null;
    } catch (e) {
      console.error(
        "[SessionStateService] Failed to load active session ID:",
        e,
      );
      return null;
    }
  }

  /**
   * Resolve active run ID from persisted session state
   * Returns null if no active session exists or session data is unavailable
   */
  static loadActiveSessionRunId(): string | null {
    const activeSessionId = this.loadActiveSessionId();
    if (!activeSessionId) {
      return this.loadSetupSession()?.activeRunId ?? null;
    }

    const sessions = this.loadSessions();
    return (
      sessions[activeSessionId]?.activeRunId ??
      this.loadSetupSession()?.activeRunId ??
      null
    );
  }

  /**
   * Load the current lightweight setup session used before any repo-backed
   * session exists.
   */
  static loadSetupSession(): SetupSessionState | null {
    try {
      const stored = localStorage.getItem(SETUP_SESSION_KEY);
      if (!stored) {
        return null;
      }

      const parsed = JSON.parse(stored) as Partial<SetupSessionState>;
      if (
        parsed.kind !== "setup" ||
        !parsed.id ||
        !parsed.activeRunId ||
        !parsed.createdAt ||
        !parsed.updatedAt
      ) {
        return null;
      }

      return {
        id: parsed.id,
        kind: "setup",
        activeRunId: parsed.activeRunId,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };
    } catch (e) {
      console.error("[SessionStateService] Failed to load setup session:", e);
      return null;
    }
  }

  /**
   * Save the current setup session so provider-scoped setup survives refreshes.
   */
  static saveSetupSession(session: SetupSessionState): void {
    try {
      localStorage.setItem(SETUP_SESSION_KEY, JSON.stringify(session));
    } catch (e) {
      console.error("[SessionStateService] Failed to save setup session:", e);
    }
  }

  /**
   * Clear setup session state after auth loss or once a real repo session exists.
   */
  static clearSetupSession(): void {
    try {
      localStorage.removeItem(SETUP_SESSION_KEY);
    } catch (e) {
      console.error("[SessionStateService] Failed to clear setup session:", e);
    }
  }

  /**
   * Save the currently active session ID
   * Validates that the session exists before saving
   */
  static saveActiveSessionId(
    sessionId: string | null,
    sessions: Record<string, AgentSession>,
  ): void {
    // Validate session exists if setting active
    if (sessionId && !sessions[sessionId]) {
      console.warn(
        "[SessionStateService] Attempted to set non-existent session as active:",
        sessionId,
      );
      return;
    }

    try {
      if (sessionId) {
        localStorage.setItem(ACTIVE_SESSION_ID_KEY, sessionId);
      } else {
        localStorage.removeItem(ACTIVE_SESSION_ID_KEY);
      }
    } catch (e) {
      console.error(
        "[SessionStateService] Failed to save active session ID:",
        e,
      );
    }
  }

  /**
   * Load GitHub context for a specific session
   * Returns null if not found or corrupted
   */
  static loadSessionGitHubContext(
    sessionId: string,
  ): SessionGitHubContext | null {
    try {
      const key = getSessionContextKey(sessionId);
      const stored = localStorage.getItem(key);
      if (!stored) {
        return null;
      }

      const parsed = JSON.parse(stored) as Partial<SessionGitHubContext>;
      if (
        typeof parsed.repoOwner !== "string" ||
        typeof parsed.repoName !== "string" ||
        typeof parsed.fullName !== "string" ||
        typeof parsed.branch !== "string"
      ) {
        return null;
      }

      return {
        repoOwner: parsed.repoOwner,
        repoName: parsed.repoName,
        fullName: parsed.fullName,
        branch: parsed.branch,
      };
    } catch (e) {
      console.error(
        "[SessionStateService] Failed to load GitHub context for session:",
        sessionId,
        e,
      );
      return null;
    }
  }

  /**
   * Save GitHub context for a specific session
   * Enforces session-scoped storage
   */
  static saveSessionGitHubContext(
    sessionId: string,
    context: SessionGitHubContext,
  ): void {
    try {
      const key = getSessionContextKey(sessionId);
      localStorage.setItem(key, JSON.stringify(context));
    } catch (e) {
      console.error(
        "[SessionStateService] Failed to save GitHub context for session:",
        sessionId,
        e,
      );
    }
  }

  /**
   * Clear GitHub context for a specific session
   */
  static clearSessionGitHubContext(sessionId: string): void {
    try {
      const key = getSessionContextKey(sessionId);
      localStorage.removeItem(key);
    } catch (e) {
      console.error(
        "[SessionStateService] Failed to clear GitHub context for session:",
        sessionId,
        e,
      );
    }
  }

  /**
   * Load pending query for a specific session
   */
  static loadSessionPendingQuery(sessionId: string): string | null {
    try {
      const key = getSessionPendingQueryKey(sessionId);
      return localStorage.getItem(key);
    } catch (e) {
      console.error(
        "[SessionStateService] Failed to load pending query for session:",
        sessionId,
        e,
      );
      return null;
    }
  }

  /**
   * Save pending query for a specific session
   */
  static saveSessionPendingQuery(sessionId: string, query: string): void {
    try {
      const key = getSessionPendingQueryKey(sessionId);
      localStorage.setItem(key, query);
    } catch (e) {
      console.error(
        "[SessionStateService] Failed to save pending query for session:",
        sessionId,
        e,
      );
    }
  }

  /**
   * Clear pending query for a specific session
   */
  static clearSessionPendingQuery(sessionId: string): void {
    try {
      const key = getSessionPendingQueryKey(sessionId);
      localStorage.removeItem(key);
    } catch (e) {
      console.error(
        "[SessionStateService] Failed to clear pending query for session:",
        sessionId,
        e,
      );
    }
  }

  /**
   * Create a new session
   * Returns the created session
   */
  static createSession(
    name: string,
    repository: string,
    status: SessionStatus = "idle",
    mode: RunMode = DEFAULT_RUN_MODE,
  ): AgentSession {
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    return {
      id: sessionId,
      name,
      titleSource: "generated",
      repository,
      activeRunId: runId,
      runIds: [runId],
      status,
      pinnedAt: null,
      archivedAt: null,
      mode,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Create a setup-scoped shell session that can back provider setup before a
   * repo-backed session exists.
   */
  static createSetupSession(): SetupSessionState {
    const timestamp = new Date().toISOString();

    return {
      id: crypto.randomUUID(),
      kind: "setup",
      activeRunId: crypto.randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /**
   * Update session status
   * Maintains updatedAt timestamp
   */
  static updateSessionStatus(
    session: AgentSession,
    status: SessionStatus,
  ): AgentSession {
    return {
      ...session,
      status,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Add a new run to a session
   * Useful for supporting multiple runs per session in future PRs
   */
  static addRunToSession(
    session: AgentSession,
    runId: string,
    makeActive: boolean = true,
  ): AgentSession {
    if (session.runIds.includes(runId)) {
      console.warn(
        "[SessionStateService] Run already in session:",
        runId,
        session.id,
      );
      return session;
    }

    return {
      ...session,
      runIds: [...session.runIds, runId],
      activeRunId: makeActive ? runId : session.activeRunId,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Validate session invariants
   * Returns true if session is valid
   */
  static validateSession(session: AgentSession): boolean {
    const validStatuses = ["idle", "running", "completed", "error"] as const;
    const checks = [
      { name: "id", pass: !!session.id },
      { name: "name", pass: !!session.name },
      {
        name: "titleSource",
        pass:
          session.titleSource === "generated" || session.titleSource === "user",
      },
      { name: "activeRunId", pass: !!session.activeRunId },
      { name: "runIds", pass: Array.isArray(session.runIds) },
      {
        name: "status",
        pass: validStatuses.includes(
          session.status as (typeof validStatuses)[number],
        ),
      },
      {
        name: "mode",
        pass: session.mode === "build" || session.mode === "plan",
      },
      {
        name: "activeRunId-in-runIds",
        pass: session.runIds.includes(session.activeRunId),
      },
      {
        name: "repository",
        pass:
          session.repository === null || session.repository.trim().length > 0,
      },
      { name: "updatedAt", pass: !!session.updatedAt },
    ];

    const failures = checks.filter((c) => !c.pass);
    if (failures.length > 0) {
      console.warn(
        "[SessionStateService] Validation failed for session",
        session.id,
        "Failed checks:",
        failures.map((f) => f.name),
      );
      return false;
    }

    return true;
  }
}

function normalizeSession(session: StoredAgentSession): AgentSession {
  return {
    ...session,
    mode: session.mode ?? DEFAULT_RUN_MODE,
    titleSource: session.titleSource ?? "generated",
    pinnedAt: session.pinnedAt ?? null,
    archivedAt: session.archivedAt ?? null,
  };
}

function mapServerSession(session: ServerSessionRecord): AgentSession | null {
  if (!session.activeRunId) {
    return null;
  }

  return {
    id: session.id,
    name: session.title,
    titleSource: session.titleSource ?? "generated",
    repository: session.repository,
    activeRunId: session.activeRunId,
    runIds: [session.activeRunId],
    status: mapServerStatus(session.status),
    mode: session.mode ?? DEFAULT_RUN_MODE,
    pinnedAt: session.pinnedAt ?? null,
    archivedAt: session.archivedAt ?? null,
    updatedAt: session.updatedAt,
  };
}

function mapServerStatus(status: ServerSessionRecord["status"]): SessionStatus {
  if (status === "failed") {
    return "error";
  }
  return status;
}

async function sendSessionMutation(
  path: string,
  operation: string,
): Promise<AgentSession> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
  });
  return readMetadataMutationResponse(response, operation);
}

async function readMetadataMutationResponse(
  response: Response,
  operation: string,
): Promise<AgentSession> {
  if (!response.ok) {
    throw new Error(`${operation} failed: ${response.status}`);
  }
  return readServerSessionResponse(response);
}

async function readServerSessionResponse(
  response: Response,
): Promise<AgentSession> {
  const payload = (await response.json()) as Partial<ServerSessionResponse>;
  const session = payload.session ? mapServerSession(payload.session) : null;
  if (!session) {
    throw new Error("Invalid session response");
  }
  return session;
}
