/**
 * SessionStateService Tests
 *
 * Tests for session persistence, validation, and operations.
 * Covers isolation rules and storage key strategy.
 *
 * @module services/__tests__/SessionStateService.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionStateService } from "../SessionStateService";
import type { AgentSession } from "../../types/session";

describe("SessionStateService", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("Session Persistence", () => {
    it("should save and load sessions", () => {
      const session = SessionStateService.createSession(
        "Test Session",
        "test-repo",
      );

      const sessions = { [session.id]: session };
      SessionStateService.saveSessions(sessions);

      const loaded = SessionStateService.loadSessions();
      expect(loaded).toEqual(sessions);
      expect(loaded[session.id]).toBeDefined();
    });

    it("should return empty object when no sessions exist", () => {
      const loaded = SessionStateService.loadSessions();
      expect(loaded).toEqual({});
    });

    it("should handle corrupted localStorage gracefully", () => {
      localStorage.setItem("shadowbox:sessions:v3", "invalid json");
      const loaded = SessionStateService.loadSessions();
      expect(loaded).toEqual({});
    });

    it("rejects sessions with invalid persisted statuses", () => {
      const session = SessionStateService.createSession("Test", "repo");

      localStorage.setItem(
        "shadowbox:sessions:v3",
        JSON.stringify({
          version: 3,
          sessions: {
            [session.id]: {
              ...session,
              status: "error",
            },
          },
          activeSessionId: session.id,
          lastModified: new Date().toISOString(),
        }),
      );

      const loaded = SessionStateService.loadSessions();
      expect(loaded[session.id]).toBeUndefined();
    });
  });

  describe("Server Session Hydration", () => {
    it("hydrates canonical sessions from Brain", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            sessions: [
              {
                id: "550e8400-e29b-41d4-a716-446655440000",
                title: "Server Task",
                repository: "acme/legioncode",
                activeRunId: "550e8400-e29b-41d4-a716-446655440001",
                mode: "build",
                status: "failed",
                updatedAt: "2026-05-15T00:00:00.000Z",
              },
            ],
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const sessions = await SessionStateService.hydrateSessionsFromServer();

      const session = sessions["550e8400-e29b-41d4-a716-446655440000"];
      expect(session?.name).toBe("Server Task");
      expect(session?.status).toBe("failed");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/sessions"),
        { credentials: "include" },
      );
    });

    it("persists created sessions to Brain", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ session: createServerSession("Task") }), {
          status: 201,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const session = SessionStateService.createSession("Task", "repo");

      await SessionStateService.persistSession(session);

      const [, requestInit] = fetchMock.mock.calls[0] ?? [];
      const body = JSON.parse(String(requestInit?.body));
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/sessions"),
        expect.objectContaining({
          method: "POST",
          credentials: "include",
        }),
      );
      expect(body).toMatchObject({
        sessionId: session.id,
        runId: session.activeRunId,
      });
    });

    it("archives sessions through Brain", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ session: createServerSession("Task") }), {
          status: 200,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await SessionStateService.archiveSession(
        "550e8400-e29b-41d4-a716-446655440000",
      );

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "/api/sessions/550e8400-e29b-41d4-a716-446655440000/archive",
        ),
        {
          method: "POST",
          credentials: "include",
        },
      );
    });
  });

  describe("Active Session ID", () => {
    it("should save and load active session ID", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const sessions = { [session.id]: session };

      SessionStateService.saveActiveSessionId(session.id, sessions);
      const loaded = SessionStateService.loadActiveSessionId();

      expect(loaded).toBe(session.id);
    });

    it("should not save non-existent session as active", () => {
      const sessions = {};
      SessionStateService.saveActiveSessionId("non-existent", sessions);

      const loaded = SessionStateService.loadActiveSessionId();
      expect(loaded).toBeNull();
    });

    it("should clear active session ID when null", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const sessions = { [session.id]: session };

      SessionStateService.saveActiveSessionId(session.id, sessions);
      SessionStateService.saveActiveSessionId(null, sessions);

      const loaded = SessionStateService.loadActiveSessionId();
      expect(loaded).toBeNull();
    });
  });

  describe("Active Run Resolution", () => {
    it("should resolve active run ID from active session", () => {
      const session = SessionStateService.createSession("Test Session", "repo");
      const sessions = { [session.id]: session };

      SessionStateService.saveSessions(sessions, session.id);
      SessionStateService.saveActiveSessionId(session.id, sessions);

      const runId = SessionStateService.loadActiveSessionRunId();
      expect(runId).toBe(session.activeRunId);
    });

    it("should return null when active session is missing", () => {
      const runId = SessionStateService.loadActiveSessionRunId();
      expect(runId).toBeNull();
    });

    it("should fall back to setup session run ID when no repo session exists", () => {
      const setupSession = SessionStateService.createSetupSession();
      SessionStateService.saveSetupSession(setupSession);

      const runId = SessionStateService.loadActiveSessionRunId();

      expect(runId).toBe(setupSession.activeRunId);
    });

    it("should fall back to setup session run ID when active session cannot be resolved", () => {
      const session = SessionStateService.createSession("Test Session", "repo");
      const setupSession = SessionStateService.createSetupSession();

      SessionStateService.saveSessions(
        { [session.id]: session },
        "missing-session",
      );
      SessionStateService.saveActiveSessionId(session.id, {
        [session.id]: session,
      });
      localStorage.setItem("shadowbox:active-session-id:v3", "missing-session");
      SessionStateService.saveSetupSession(setupSession);

      const runId = SessionStateService.loadActiveSessionRunId();

      expect(runId).toBe(setupSession.activeRunId);
    });
  });

  describe("Setup Session Persistence", () => {
    it("should save and load setup session state", () => {
      const setupSession = SessionStateService.createSetupSession();

      SessionStateService.saveSetupSession(setupSession);

      expect(SessionStateService.loadSetupSession()).toEqual(setupSession);
    });

    it("should clear setup session state", () => {
      const setupSession = SessionStateService.createSetupSession();

      SessionStateService.saveSetupSession(setupSession);
      SessionStateService.clearSetupSession();

      expect(SessionStateService.loadSetupSession()).toBeNull();
    });
  });

  describe("Session-Scoped GitHub Context", () => {
    it("should save and load GitHub context for session", () => {
      const sessionId = "session-1";
      const context = {
        repoOwner: "user",
        repoName: "repo",
        fullName: "user/repo",
        branch: "main",
      };

      SessionStateService.saveSessionGitHubContext(sessionId, context);
      const loaded = SessionStateService.loadSessionGitHubContext(sessionId);

      expect(loaded).toEqual(context);
    });

    it("should return null for non-existent session context", () => {
      const loaded = SessionStateService.loadSessionGitHubContext("unknown");
      expect(loaded).toBeNull();
    });

    it("should clear context for specific session", () => {
      const sessionId = "session-1";
      const context = {
        repoOwner: "user",
        repoName: "repo",
        fullName: "user/repo",
        branch: "main",
      };

      SessionStateService.saveSessionGitHubContext(sessionId, context);
      SessionStateService.clearSessionGitHubContext(sessionId);

      const loaded = SessionStateService.loadSessionGitHubContext(sessionId);
      expect(loaded).toBeNull();
    });

    it("should isolate contexts between sessions", () => {
      const context1 = {
        repoOwner: "user1",
        repoName: "repo1",
        fullName: "user1/repo1",
        branch: "main",
      };

      const context2 = {
        repoOwner: "user2",
        repoName: "repo2",
        fullName: "user2/repo2",
        branch: "dev",
      };

      SessionStateService.saveSessionGitHubContext("session-1", context1);
      SessionStateService.saveSessionGitHubContext("session-2", context2);

      const loaded1 = SessionStateService.loadSessionGitHubContext("session-1");
      const loaded2 = SessionStateService.loadSessionGitHubContext("session-2");

      expect(loaded1).toEqual(context1);
      expect(loaded2).toEqual(context2);
    });
  });

  describe("Session-Scoped Pending Queries", () => {
    it("should save and load pending query for session", () => {
      const sessionId = "session-1";
      const query = "test task description";

      SessionStateService.saveSessionPendingQuery(sessionId, query);
      const loaded = SessionStateService.loadSessionPendingQuery(sessionId);

      expect(loaded).toBe(query);
    });

    it("should return null for non-existent pending query", () => {
      const loaded = SessionStateService.loadSessionPendingQuery("unknown");
      expect(loaded).toBeNull();
    });

    it("should clear pending query for specific session", () => {
      const sessionId = "session-1";
      const query = "test task";

      SessionStateService.saveSessionPendingQuery(sessionId, query);
      SessionStateService.clearSessionPendingQuery(sessionId);

      const loaded = SessionStateService.loadSessionPendingQuery(sessionId);
      expect(loaded).toBeNull();
    });

    it("should isolate pending queries between sessions", () => {
      SessionStateService.saveSessionPendingQuery("session-1", "query 1");
      SessionStateService.saveSessionPendingQuery("session-2", "query 2");

      const loaded1 = SessionStateService.loadSessionPendingQuery("session-1");
      const loaded2 = SessionStateService.loadSessionPendingQuery("session-2");

      expect(loaded1).toBe("query 1");
      expect(loaded2).toBe("query 2");
    });
  });

  describe("Session Creation", () => {
    it("should create session with required fields", () => {
      const session = SessionStateService.createSession(
        "Test Session",
        "test-repo",
      );

      expect(session.id).toBeTruthy();
      expect(session.name).toBe("Test Session");
      expect(session.repository).toBe("test-repo");
      expect(session.activeRunId).toBeTruthy();
      expect(session.runIds).toContain(session.activeRunId);
      expect(session.status).toBe("idle");
      expect(session.mode).toBe("build");
      expect(session.updatedAt).toBeTruthy();
    });

    it("should create unique session IDs", () => {
      const session1 = SessionStateService.createSession("Session 1", "repo");
      const session2 = SessionStateService.createSession("Session 2", "repo");

      expect(session1.id).not.toBe(session2.id);
      expect(session1.activeRunId).not.toBe(session2.activeRunId);
    });

    it("should allow custom status on creation", () => {
      const session = SessionStateService.createSession(
        "Test",
        "repo",
        "running",
      );
      expect(session.status).toBe("running");
    });

    it("normalizes missing organization metadata when loading", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const { mode, titleSource, pinnedAt, archivedAt, ...storedSession } =
        session;
      expect(mode).toBe("build");
      expect(titleSource).toBe("generated");
      expect(pinnedAt).toBeNull();
      expect(archivedAt).toBeNull();

      localStorage.setItem(
        "shadowbox:sessions:v3",
        JSON.stringify({
          version: 3,
          sessions: { [session.id]: storedSession },
          activeSessionId: session.id,
          lastModified: new Date().toISOString(),
        }),
      );

      const loaded = SessionStateService.loadSessions();
      expect(loaded[session.id]?.mode).toBe("build");
      expect(loaded[session.id]?.titleSource).toBe("generated");
      expect(loaded[session.id]?.pinnedAt).toBeNull();
      expect(loaded[session.id]?.archivedAt).toBeNull();
    });
  });

  describe("Session Status Updates", () => {
    it("should update session status", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-21T00:00:00.000Z"));
      const session = SessionStateService.createSession("Test", "repo");

      vi.setSystemTime(new Date("2026-02-21T00:00:00.001Z"));
      const updated = SessionStateService.updateSessionStatus(
        session,
        "running",
      );

      expect(updated.status).toBe("running");
      expect(updated.updatedAt).not.toBe(session.updatedAt);
    });

    it("accepts paused as a valid terminal session status", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const updated = SessionStateService.updateSessionStatus(
        session,
        "paused",
      );

      expect(updated.status).toBe("paused");
      expect(SessionStateService.validateSession(updated)).toBe(true);
    });

    it("should preserve other fields when updating status", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const updated = SessionStateService.updateSessionStatus(
        session,
        "completed",
      );

      expect(updated.id).toBe(session.id);
      expect(updated.name).toBe(session.name);
      expect(updated.repository).toBe(session.repository);
    });
  });

  describe("Run Management", () => {
    it("should add run to session", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const newRunId = "run-123";

      const updated = SessionStateService.addRunToSession(
        session,
        newRunId,
        true,
      );

      expect(updated.runIds).toContain(newRunId);
      expect(updated.activeRunId).toBe(newRunId);
    });

    it("should add run without making it active", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const originalRunId = session.activeRunId;
      const newRunId = "run-123";

      const updated = SessionStateService.addRunToSession(
        session,
        newRunId,
        false,
      );

      expect(updated.runIds).toContain(newRunId);
      expect(updated.activeRunId).toBe(originalRunId);
    });

    it("should warn when adding duplicate run", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const originalWarn = globalThis.console.warn;
      let warnCalled = false;

      globalThis.console.warn = () => {
        warnCalled = true;
      };

      SessionStateService.addRunToSession(session, session.activeRunId, true);

      globalThis.console.warn = originalWarn;
      expect(warnCalled).toBe(true);
    });
  });

  describe("Session Validation", () => {
    it("should validate correct session", () => {
      const session = SessionStateService.createSession("Test", "repo");
      expect(SessionStateService.validateSession(session)).toBe(true);
    });

    it("should reject session with missing id", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const invalid = { ...session, id: "" };
      expect(SessionStateService.validateSession(invalid)).toBe(false);
    });

    it("should reject session with activeRunId not in runIds", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const invalid = { ...session, activeRunId: "unknown-run" };
      expect(SessionStateService.validateSession(invalid)).toBe(false);
    });

    it("should reject session with invalid status", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const invalid = {
        ...session,
        status: "invalid" as unknown as AgentSession["status"],
      };
      expect(SessionStateService.validateSession(invalid)).toBe(false);
    });

    it("should reject session with non-array runIds", () => {
      const session = SessionStateService.createSession("Test", "repo");
      const invalid = {
        ...session,
        runIds: "not an array" as unknown as string[],
      };
      expect(SessionStateService.validateSession(invalid)).toBe(false);
    });
  });

  describe("Multi-Session Isolation", () => {
    it("should maintain separate state for multiple sessions", () => {
      const session1 = SessionStateService.createSession("Session 1", "repo1");
      const session2 = SessionStateService.createSession("Session 2", "repo2");

      // Save different contexts
      const context1 = {
        repoOwner: "user1",
        repoName: "repo1",
        fullName: "user1/repo1",
        branch: "main",
      };
      const context2 = {
        repoOwner: "user2",
        repoName: "repo2",
        fullName: "user2/repo2",
        branch: "dev",
      };

      SessionStateService.saveSessionGitHubContext(session1.id, context1);
      SessionStateService.saveSessionGitHubContext(session2.id, context2);

      // Load and verify isolation
      const loaded1 = SessionStateService.loadSessionGitHubContext(session1.id);
      const loaded2 = SessionStateService.loadSessionGitHubContext(session2.id);

      expect(loaded1?.fullName).toBe("user1/repo1");
      expect(loaded2?.fullName).toBe("user2/repo2");
      expect(loaded1).not.toEqual(loaded2);
    });

    it("should not leak pending queries between sessions", () => {
      SessionStateService.saveSessionPendingQuery("session-1", "query 1");
      SessionStateService.saveSessionPendingQuery("session-2", "query 2");

      // Clearing one should not affect the other
      SessionStateService.clearSessionPendingQuery("session-1");

      const loaded1 = SessionStateService.loadSessionPendingQuery("session-1");
      const loaded2 = SessionStateService.loadSessionPendingQuery("session-2");

      expect(loaded1).toBeNull();
      expect(loaded2).toBe("query 2");
    });
  });
});

function createServerSession(title: string) {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    title,
    titleSource: "generated",
    repository: "repo",
    activeRunId: "550e8400-e29b-41d4-a716-446655440001",
    mode: "build",
    status: "idle",
    pinnedAt: null,
    archivedAt: null,
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}
