/**
 * SessionStateService
 *
 * Local session construction/validation and narrow UI preference references.
 * Hosted session metadata and history are owned by the authenticated SDK path.
 *
 * Storage Keys:
 * - legioncode:active-session-id:v4 — Per-tab active session selector
 * - legioncode:session-context:{sessionId} — GitHub context per session
 * - legioncode:setup-session:v1 — Read-only legacy preference lookup
 *
 * @module services/SessionStateService
 */

import { DEFAULT_RUN_MODE, type RunMode } from "@repo/shared-types";
import type {
  AgentSession,
  SessionStatus,
  SessionGitHubContext,
  SetupSessionState,
} from "../types/session";
import { createRunId, isCanonicalRunId } from "../lib/run-id";

const ACTIVE_SESSION_ID_KEY = "legioncode:active-session-id:v4";
const SETUP_SESSION_KEY = "legioncode:setup-session:v1";

function getSessionContextKey(sessionId: string): string {
  return `legioncode:session-context:${sessionId}`;
}

/**
 * SessionStateService
 * Local session helpers; durable product state is read through the SDK
 */
export class SessionStateService {
  /**
   * Read the current tab's saved selection as an unverified reference.
   * Callers must resolve it against the owned server session snapshot before use.
   */
  static loadActiveSessionId(): string | null {
    try {
      const stored = sessionStorage.getItem(ACTIVE_SESSION_ID_KEY);
      return stored && stored.trim().length > 0 ? stored : null;
    } catch (e) {
      console.error(
        "[SessionStateService] Failed to load active session ID:",
        e,
      );
      return null;
    }
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
        typeof parsed.id !== "string" || !parsed.id.trim() ||
        typeof parsed.createdAt !== "string" || !parsed.createdAt.trim() ||
        typeof parsed.updatedAt !== "string" || !parsed.updatedAt.trim()
      ) {
        return null;
      }

      return {
        id: parsed.id,
        kind: "setup",
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };
    } catch (e) {
      console.error("[SessionStateService] Failed to load setup session:", e);
      return null;
    }
  }

  /** Preserve legacy lookup bytes; new setup uses only a local preference scope. */
  static loadOrCreateSetupSession(scope?: { userId: string; workspaceId: string }): SetupSessionState {
    return this.loadSetupSession() ?? this.createSetupSession(scope);
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
        sessionStorage.setItem(ACTIVE_SESSION_ID_KEY, sessionId);
      } else {
        sessionStorage.removeItem(ACTIVE_SESSION_ID_KEY);
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
   * Create a new session
   * Returns the created session
   */
  static createSession(
    name: string,
    repository: string | null,
    status: SessionStatus = "idle",
    mode: RunMode = DEFAULT_RUN_MODE,
  ): AgentSession {
    const sessionId = crypto.randomUUID();
    const runId = createRunId();
    const timestamp = new Date().toISOString();

    return {
      id: sessionId,
      name,
      titleSource: "preview",
      repository,
      activeRunId: runId,
      runIds: [runId],
      status,
      pinnedAt: null,
      archivedAt: null,
      mode,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /** Create a local preference scope before a repo-backed session exists. */
  static createSetupSession(scope?: { userId: string; workspaceId: string }): SetupSessionState {
    const timestamp = new Date().toISOString();

    return {
      id: scope
        ? `setup-preferences:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.workspaceId)}`
        : crypto.randomUUID(),
      kind: "setup",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /**
   * Validate session invariants
   * Returns true if session is valid
   */
  static validateSession(session: AgentSession): boolean {
    const validStatuses = [
      "idle",
      "running",
      "waiting_for_approval",
      "completed",
      "paused",
      "failed",
    ] as const;
    const checks = [
      { name: "id", pass: !!session.id },
      { name: "name", pass: !!session.name },
      {
        name: "titleSource",
        pass:
          session.titleSource === "preview" ||
          session.titleSource === "generated" ||
          session.titleSource === "user",
      },
      {
        name: "activeRunId",
        pass: session.activeRunId === null || isCanonicalRunId(session.activeRunId),
      },
      {
        name: "runIds",
        pass:
          Array.isArray(session.runIds) &&
          session.runIds.every(isCanonicalRunId),
      },
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
        pass:
          session.activeRunId === null ||
          session.runIds.includes(session.activeRunId),
      },
      {
        name: "repository",
        pass:
          session.repository === null || session.repository.trim().length > 0,
      },
      { name: "updatedAt", pass: !!session.updatedAt },
      { name: "createdAt", pass: !!session.createdAt },
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
