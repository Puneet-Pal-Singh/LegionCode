/**
 * useSessionManager Tests
 *
 * Tests for session management with v2 schema and multi-session isolation.
 * Validates session creation, switching, and cleanup.
 *
 * @module hooks/__tests__/useSessionManager.test
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgentSession } from "../../types/session";
import { useSessionManager } from "../useSessionManager";
import { SessionStateService } from "../../services/SessionStateService";

describe("useSessionManager", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("Session Creation", () => {
    it("should create a new session", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Test Task", "test-repo");
      });

      expect(sessionId).toBeTruthy();
      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0]?.name).toBe("Test Task");
      expect(result.current.sessions[0]?.repository).toBe("test-repo");
    });

    it("should create session with default name", () => {
      const { result } = renderHook(() => useSessionManager());

      act(() => {
        result.current.createSession(undefined, "test-repo");
      });

      expect(result.current.sessions[0]?.name).toBe("New Task");
    });

    it("should add repository on session creation", () => {
      const { result } = renderHook(() => useSessionManager());

      act(() => {
        result.current.createSession("Task", "new-repo");
      });

      expect(result.current.repositories).toContain("new-repo");
    });

    it("should set created session as active", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      expect(result.current.activeSessionId).toBe(sessionId);
    });

    it("should generate unique run IDs for each session", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId1 = "";
      let sessionId2 = "";
      act(() => {
        sessionId1 = result.current.createSession("Task 1", "repo");
        sessionId2 = result.current.createSession("Task 2", "repo");
      });

      const session1 = result.current.sessions.find((s: AgentSession) => s.id === sessionId1);
      const session2 = result.current.sessions.find((s: AgentSession) => s.id === sessionId2);

      expect(session1?.activeRunId).not.toBe(session2?.activeRunId);
    });
  });

  describe("Session Switching", () => {
    it("should switch active session", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId1 = "";
      act(() => {
        sessionId1 = result.current.createSession("Task 1", "repo");
        result.current.createSession("Task 2", "repo");
      });

      act(() => {
        result.current.setActiveSessionId(sessionId1);
      });

      expect(result.current.activeSessionId).toBe(sessionId1);
    });

    it("should persist active session to localStorage", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      expect(SessionStateService.loadActiveSessionId()).toBe(sessionId);
    });
  });

  describe("Session Removal", () => {
    it("should remove session", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId: string;
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      expect(result.current.sessions).toHaveLength(1);

      act(() => {
        result.current.removeSession(sessionId);
      });

      expect(result.current.sessions).toHaveLength(0);
    });

    it("should clear active session if removed session is active", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      expect(result.current.activeSessionId).toBe(sessionId);

      act(() => {
        result.current.removeSession(sessionId);
      });

      expect(result.current.activeSessionId).toBeNull();
    });

    it("should clear session GitHub context on removal", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      // Save context for session
      const context = {
        repoOwner: "user",
        repoName: "repo",
        fullName: "user/repo",
        branch: "main",
      };
      SessionStateService.saveSessionGitHubContext(sessionId, context);

      // Remove session
      act(() => {
        result.current.removeSession(sessionId);
      });

      // Verify context is cleared
      const loaded = SessionStateService.loadSessionGitHubContext(sessionId);
      expect(loaded).toBeNull();
    });

    it("should clear session pending query on removal", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      // Save pending query
      SessionStateService.saveSessionPendingQuery(sessionId, "test query");

      // Remove session
      act(() => {
        result.current.removeSession(sessionId);
      });

      // Verify pending query is cleared
      const loaded = SessionStateService.loadSessionPendingQuery(sessionId);
      expect(loaded).toBeNull();
    });
  });

  describe("Session Updates", () => {
    it("should update session properties", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      act(() => {
        result.current.updateSession(sessionId, { name: "Updated Task" });
      });

      const session = result.current.sessions.find((s: AgentSession) => s.id === sessionId);
      expect(session?.name).toBe("Updated Task");
    });

    it("should update session status", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      act(() => {
        result.current.updateSession(sessionId, { status: "running" });
      });

      const session = result.current.sessions.find((s: AgentSession) => s.id === sessionId);
      expect(session?.status).toBe("running");
    });

    it("should not update updatedAt for no-op updates", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      const original = result.current.sessions.find((s: AgentSession) => s.id === sessionId);
      expect(original).toBeDefined();

      act(() => {
        result.current.updateSession(sessionId, { status: original!.status });
      });

      const afterNoOp = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId,
      );
      expect(afterNoOp?.updatedAt).toBe(original?.updatedAt);
    });

    it("should reject invalid session updates", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      const originalSession = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId,
      );

      // Try to set activeRunId to a non-existent run
      act(() => {
        result.current.updateSession(sessionId, {
          activeRunId: "non-existent-run",
        } as unknown as Partial<Omit<AgentSession, "id">>);
      });

      // Session should remain unchanged
      const updatedSession = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId,
      );
      expect(updatedSession?.activeRunId).toBe(originalSession?.activeRunId);
    });
  });

  describe("Repository Management", () => {
    it("should add repository", () => {
      const { result } = renderHook(() => useSessionManager());

      act(() => {
        result.current.addRepository("new-repo");
      });

      expect(result.current.repositories).toContain("new-repo");
    });

    it("should not add duplicate repositories", () => {
      const { result } = renderHook(() => useSessionManager());

      act(() => {
        result.current.addRepository("repo");
        result.current.addRepository("repo");
      });

      const repoCount = result.current.repositories.filter((r: string) => r === "repo")
        .length;
      expect(repoCount).toBe(1);
    });

    it("should remove repository", () => {
      const { result } = renderHook(() => useSessionManager());

      act(() => {
        result.current.addRepository("repo");
      });

      expect(result.current.repositories).toContain("repo");

      act(() => {
        result.current.removeRepository("repo");
      });

      expect(result.current.repositories).not.toContain("repo");
    });

    it("should remove sessions when removing repository", () => {
      const { result } = renderHook(() => useSessionManager());

      act(() => {
        result.current.createSession("Task 1", "repo");
        result.current.createSession("Task 2", "repo");
      });

      expect(result.current.sessions).toHaveLength(2);

      act(() => {
        result.current.removeRepository("repo");
      });

      expect(result.current.sessions).toHaveLength(0);
    });

    it("should rename repository", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "old-repo");
      });

      act(() => {
        result.current.renameRepository("old-repo", "new-repo");
      });

      const session = result.current.sessions.find((s: AgentSession) => s.id === sessionId);
      expect(session?.repository).toBe("new-repo");
      expect(result.current.repositories).toContain("new-repo");
      expect(result.current.repositories).not.toContain("old-repo");
    });
  });

  describe("Persistence", () => {
    it("should persist sessions to localStorage", () => {
      const { result } = renderHook(() => useSessionManager());

      act(() => {
        result.current.createSession("Task", "repo");
      });

      // Load from localStorage to verify persistence
      const loaded = SessionStateService.loadSessions();
      expect(Object.keys(loaded)).toHaveLength(1);
    });

    it("should restore sessions on mount", () => {
      // Create and persist sessions via first hook instance
      let sessionId = "";
      const { result: result1, unmount } = renderHook(() => useSessionManager());
      act(() => {
        sessionId = result1.current.createSession("Task", "repo");
      });

      // Unmount the hook (which persists sessions to localStorage)
      unmount();

      // Remount and verify restoration from localStorage
      const { result: result2 } = renderHook(() => useSessionManager());
      expect(result2.current.sessions).toHaveLength(1);
      expect(result2.current.sessions[0]?.id).toBe(sessionId);
    });

    it("should persist active session ID", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      act(() => {
        sessionId = result.current.createSession("Task", "repo");
      });

      expect(SessionStateService.loadActiveSessionId()).toBe(sessionId);
    });
  });

  describe("Multi-Session Isolation", () => {
    it("should isolate session state", () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId1 = "";
      let sessionId2 = "";
      act(() => {
        sessionId1 = result.current.createSession("Task 1", "repo1");
        sessionId2 = result.current.createSession("Task 2", "repo2");
      });

      const session1 = result.current.sessions.find((s: AgentSession) => s.id === sessionId1);
      const session2 = result.current.sessions.find((s: AgentSession) => s.id === sessionId2);

      // Verify sessions have different properties
      expect(session1?.name).not.toBe(session2?.name);
      expect(session1?.repository).not.toBe(session2?.repository);
      expect(session1?.activeRunId).not.toBe(session2?.activeRunId);
    });

    it("should not leak messages between sessions", () => {
      // This test verifies that agentStore properly isolates messages by runId
      const { result } = renderHook(() => useSessionManager());

      let sessionId1 = "";
      let sessionId2 = "";
      act(() => {
        sessionId1 = result.current.createSession("Task 1", "repo");
        sessionId2 = result.current.createSession("Task 2", "repo");
      });

      const session1 = result.current.sessions.find((s: AgentSession) => s.id === sessionId1);
      const session2 = result.current.sessions.find((s: AgentSession) => s.id === sessionId2);

      // Sessions should have distinct activeRunIds
      expect(session1?.activeRunId).toBeDefined();
      expect(session2?.activeRunId).toBeDefined();
      expect(session1?.activeRunId).not.toBe(session2?.activeRunId);

      // Verify each session maintains its own run ID context
      expect(session1?.runIds).toContain(session1?.activeRunId);
      expect(session2?.runIds).toContain(session2?.activeRunId);
      expect(session1?.runIds).not.toContain(session2?.activeRunId);
      expect(session2?.runIds).not.toContain(session1?.activeRunId);
    });
  });

  describe("Clear All Sessions", () => {
    it("should clear all sessions and cleanup", () => {
      const { result } = renderHook(() => useSessionManager());

      act(() => {
        result.current.createSession("Task 1", "repo1");
        result.current.createSession("Task 2", "repo2");
      });

      expect(result.current.sessions).toHaveLength(2);
      expect(result.current.repositories).toHaveLength(2);

      act(() => {
        result.current.clearAllSessions();
      });

      expect(result.current.sessions).toHaveLength(0);
      expect(result.current.repositories).toHaveLength(0);
      expect(result.current.activeSessionId).toBeNull();
    });

    it("should clear v2 schema storage when clearing all sessions", () => {
      const { result } = renderHook(() => useSessionManager());

      act(() => {
        result.current.createSession("Task", "repo");
      });

      act(() => {
        result.current.clearAllSessions();
      });

      const sessions = SessionStateService.loadSessions();
      const activeId = SessionStateService.loadActiveSessionId();

      expect(sessions).toEqual({});
      expect(activeId).toBeNull();
    });
  });
});
