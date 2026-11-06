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
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
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
      const snapshot = JSON.stringify({
        version: 3,
        sessions,
        activeSessionId: null,
        lastModified: "2026-10-23T00:00:00.000Z",
      });
      localStorage.setItem("legioncode:sessions:v3", snapshot);

      const shadowSnapshot = "  {\"version\":3,\"sessions\":{}}\n";
      localStorage.setItem("shadowbox:sessions:v3", shadowSnapshot);
      const readSpy = vi.spyOn(Storage.prototype, "getItem");
      SessionStateService.saveActiveSessionId(session.id, sessions);
      expect(SessionStateService.loadActiveSessionId()).toBe(session.id);
      expect(readSpy).not.toHaveBeenCalledWith("legioncode:sessions:v3");
      expect(readSpy).not.toHaveBeenCalledWith("shadowbox:sessions:v3");
      expect(localStorage.getItem("legioncode:sessions:v3")).toBe(snapshot);
      expect(localStorage.getItem("shadowbox:sessions:v3")).toBe(shadowSnapshot);
    });

    it("should handle corrupted localStorage gracefully", () => {
      const legacyValues = {
        "legioncode:sessions:v3": "unmatched historical bytes",
        "shadowbox:sessions:v3": "  {\"version\":99,\"sessions\":{}}\n",
        legioncode_ui_shell: " {\"activeRunId\":\"legacy-only\"} ",
      };
      for (const [key, raw] of Object.entries(legacyValues)) {
        localStorage.setItem(key, raw);
      }
      const errorSpy = silenceConsoleError();
      const readSpy = vi.spyOn(Storage.prototype, "getItem");
      expect(SessionStateService.loadActiveSessionId()).toBeNull();
      SessionStateService.loadOrCreateSetupSession({
        userId: "owned-account", workspaceId: "owned-workspace",
      });
      expect(SessionStateService.loadSessionGitHubContext("unknown")).toBeNull();
      for (const key of Object.keys(legacyValues)) {
        expect(readSpy).not.toHaveBeenCalledWith(key);
      }
      expect(errorSpy).not.toHaveBeenCalled();
      for (const [key, raw] of Object.entries(legacyValues)) {
        expect(localStorage.getItem(key)).toBe(raw);
      }
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

    it("keeps active session selection scoped to the current tab", () => {
      const tabSession = SessionStateService.createSession("Tab", "repo");
      const otherTabSession = SessionStateService.createSession("Other", "repo");
      const sessions = {
        [tabSession.id]: tabSession,
        [otherTabSession.id]: otherTabSession,
      };

      localStorage.setItem(
        "legioncode:sessions:v3",
        JSON.stringify({ version: 3, sessions, activeSessionId: otherTabSession.id, lastModified: "legacy" }),
      );
      SessionStateService.saveActiveSessionId(tabSession.id, sessions);

      expect(SessionStateService.loadActiveSessionId()).toBe(tabSession.id);
    });

    it("should not save non-existent session as active", () => {
      const warnSpy = silenceConsoleWarn();
      const sessions = {};
      SessionStateService.saveActiveSessionId("non-existent", sessions);

      const loaded = SessionStateService.loadActiveSessionId();
      expect(loaded).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        "[SessionStateService] Attempted to set non-existent session as active:",
        "non-existent",
      );
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

  describe("Setup Session Persistence", () => {
    it("should save and load setup session state", () => {
      const scope = { userId: "owned-account", workspaceId: "owned-workspace" };
      const freshSetupSession = SessionStateService.loadOrCreateSetupSession(scope);
      expect(freshSetupSession).not.toHaveProperty("activeRunId");
      expect(SessionStateService.loadSetupSession()).toBeNull();
      expect(localStorage.getItem("legioncode:setup-session:v1")).toBeNull();
      expect(SessionStateService.loadOrCreateSetupSession(scope).id).toBe(freshSetupSession.id);
      expect(SessionStateService.loadOrCreateSetupSession({ ...scope, userId: "other-account" }).id).not.toBe(freshSetupSession.id);
      expect(SessionStateService.loadOrCreateSetupSession({ ...scope, workspaceId: "other-workspace" }).id).not.toBe(freshSetupSession.id);

      const storedBytes = JSON.stringify({
        ...freshSetupSession,
        activeRunId: "run_550e8400e29b41d4a716446655440001",
      });
      localStorage.setItem("legioncode:setup-session:v1", storedBytes);
      const setupSession = SessionStateService.loadSetupSession();

      expect(setupSession).not.toHaveProperty("activeRunId");
      expect(SessionStateService.loadOrCreateSetupSession()).toEqual(setupSession);
      expect(localStorage.getItem("legioncode:setup-session:v1")).toBe(storedBytes);
      const errorSpy = silenceConsoleError();
      localStorage.setItem("legioncode:setup-session:v1", "unmatched historical bytes");
      expect(SessionStateService.loadOrCreateSetupSession(scope).id).toBe(freshSetupSession.id);
      expect(localStorage.getItem("legioncode:setup-session:v1")).toBe("unmatched historical bytes");
      expect(errorSpy).toHaveBeenCalled();
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

      localStorage.setItem(
        `legioncode:session-context:${sessionId}`,
        JSON.stringify(context),
      );
      const loaded = SessionStateService.loadSessionGitHubContext(sessionId);

      expect(loaded).toEqual(context);
    });

    it("should return null for non-existent session context", () => {
      const loaded = SessionStateService.loadSessionGitHubContext("unknown");
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

      localStorage.setItem("legioncode:session-context:session-1", JSON.stringify(context1));
      localStorage.setItem("legioncode:session-context:session-2", JSON.stringify(context2));

      const loaded1 = SessionStateService.loadSessionGitHubContext("session-1");
      const loaded2 = SessionStateService.loadSessionGitHubContext("session-2");

      expect(loaded1).toEqual(context1);
      expect(loaded2).toEqual(context2);
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
  });

  describe("Session Status Updates", () => {
    it("accepts paused as a valid terminal session status", () => {
      const updated = SessionStateService.createSession("Test", "repo", "paused");

      expect(updated.status).toBe("paused");
      expect(SessionStateService.validateSession(updated)).toBe(true);
    });
  });

  describe("Session Validation", () => {
    it("should validate correct session", () => {
      const session = SessionStateService.createSession("Test", "repo");
      expect(SessionStateService.validateSession(session)).toBe(true);
      expect(session.activeRunId).toMatch(/^run_/);
    });

    it("should reject session with missing id", () => {
      const warnSpy = silenceConsoleWarn();
      const session = SessionStateService.createSession("Test", "repo");
      const invalid = { ...session, id: "" };
      expect(SessionStateService.validateSession(invalid)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        "[SessionStateService] Validation failed for session",
        "",
        "Failed checks:",
        expect.arrayContaining(["id"]),
      );
    });

    it("should reject session with activeRunId not in runIds", () => {
      const warnSpy = silenceConsoleWarn();
      const session = SessionStateService.createSession("Test", "repo");
      const invalid = { ...session, activeRunId: "unknown-run" };
      expect(SessionStateService.validateSession(invalid)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        "[SessionStateService] Validation failed for session",
        session.id,
        "Failed checks:",
        expect.arrayContaining(["activeRunId", "activeRunId-in-runIds"]),
      );
    });

    it("should reject session with invalid status", () => {
      const warnSpy = silenceConsoleWarn();
      const session = SessionStateService.createSession("Test", "repo");
      const invalid = {
        ...session,
        status: "invalid" as unknown as AgentSession["status"],
      };
      expect(SessionStateService.validateSession(invalid)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        "[SessionStateService] Validation failed for session",
        session.id,
        "Failed checks:",
        expect.arrayContaining(["status"]),
      );
    });

    it("should reject session with non-array runIds", () => {
      const warnSpy = silenceConsoleWarn();
      const session = SessionStateService.createSession("Test", "repo");
      const invalid = {
        ...session,
        runIds: "not an array" as unknown as string[],
      };
      expect(SessionStateService.validateSession(invalid)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        "[SessionStateService] Validation failed for session",
        session.id,
        "Failed checks:",
        expect.arrayContaining(["runIds", "activeRunId-in-runIds"]),
      );
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

      localStorage.setItem(`legioncode:session-context:${session1.id}`, JSON.stringify(context1));
      localStorage.setItem(`legioncode:session-context:${session2.id}`, JSON.stringify(context2));

      // Load and verify isolation
      const loaded1 = SessionStateService.loadSessionGitHubContext(session1.id);
      const loaded2 = SessionStateService.loadSessionGitHubContext(session2.id);

      expect(loaded1?.fullName).toBe("user1/repo1");
      expect(loaded2?.fullName).toBe("user2/repo2");
      expect(loaded1).not.toEqual(loaded2);
    });
  });
});

function silenceConsoleWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

function silenceConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}
