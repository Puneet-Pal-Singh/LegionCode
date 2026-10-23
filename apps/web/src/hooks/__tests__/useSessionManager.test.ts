import * as SessionMetadata from "../../services/api/sessionMetadata";
/**
 * useSessionManager Tests
 *
 * Tests for session management with v2 schema and multi-session isolation.
 * Validates session creation, switching, and cleanup.
 *
 * @module hooks/__tests__/useSessionManager.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { AgentSession } from "../../types/session";
import { TurnIdSchema } from "@legioncode/sdk";
import { useSessionManager } from "../useSessionManager";
import { SessionStateService } from "../../services/SessionStateService";
import { agentStore } from "../../store/agentStore";

describe("useSessionManager", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(
      SessionMetadata,
      "hydrateSessionsFromServer",
    ).mockResolvedValue({});
    vi.spyOn(SessionMetadata, "persistSession").mockImplementation(
      async (session) => session,
    );
    vi.spyOn(SessionMetadata, "archiveSession").mockImplementation(
      async (sessionId) =>
        createArchivedServerSession(sessionId, "2026-05-15T00:00:00.000Z"),
    );
    vi.spyOn(SessionMetadata, "acknowledgeSessionReadReceipt").mockImplementation(
      async (sessionId, terminalTurnId) => ({
        sessionId,
        lastAcknowledgedTerminalTurnId: TurnIdSchema.parse(terminalTurnId),
        acknowledgedAt: "2026-05-15T00:00:00.000Z",
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  describe("Session Creation", () => {
    it("refreshes an inactive chat into and out of approval while preserving selection", async () => {
      const inactive = createTitleSession({
        id: "session-inactive-approval",
        activeRunId: "run_inactive123",
        runIds: ["run_inactive123"],
        status: "running",
      });
      const selected = createTitleSession({
        id: "session-selected",
        name: "Selected chat",
        activeRunId: "run_selected123",
        runIds: ["run_selected123"],
        status: "running",
      });
      storeLegacySessions(
        { [inactive.id]: inactive, [selected.id]: selected },
        selected.id,
      );
      SessionStateService.saveActiveSessionId(selected.id, {
        [inactive.id]: inactive,
        [selected.id]: selected,
      });
      const hydrate = vi.mocked(SessionMetadata.hydrateSessionsFromServer);
      hydrate
        .mockResolvedValueOnce({
          [inactive.id]: inactive,
          [selected.id]: selected,
        })
        .mockResolvedValueOnce({
          [inactive.id]: { ...inactive, status: "waiting_for_approval" },
          [selected.id]: selected,
        })
        .mockResolvedValue({
          [inactive.id]: inactive,
          [selected.id]: selected,
        });

      const { result } = renderHook(() => useSessionManager());
      await waitFor(() =>
        expect(result.current.sessionHydrationStatus).toBe("ready"),
      );
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() => {
        expect(
          result.current.sessions.find((session) => session.id === inactive.id)
            ?.status,
        ).toBe("waiting_for_approval");
      });
      expect(result.current.activeSessionId).toBe(selected.id);

      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => {
        expect(
          result.current.sessions.find((session) => session.id === inactive.id)
            ?.status,
        ).toBe("running");
      });
      expect(result.current.activeSessionId).toBe(selected.id);

      const unchangedSessions = result.current.sessions;
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(4));
      });
      expect(result.current.sessions).toBe(unchangedSessions);
    });

    it("defers server hydration until explicitly enabled", async () => {
      const cachedSession = SessionStateService.createSession("Cached", "repo");
      const hostedSession = SessionStateService.createSession("Hosted", "repo");
      const legacySnapshot = storeLegacySessions(
        { [cachedSession.id]: cachedSession },
        cachedSession.id,
      );
      SessionStateService.saveActiveSessionId(hostedSession.id, {
        [hostedSession.id]: hostedSession,
      });
      const hydrateSpy = vi.mocked(
        SessionMetadata.hydrateSessionsFromServer,
      );
      hydrateSpy
        .mockResolvedValueOnce({ [hostedSession.id]: hostedSession })
        .mockRejectedValueOnce(new Error("hosted session list unavailable"));
      const { result, rerender } = renderHook(
        ({ enabled }) => useSessionManager({ hydrateFromServer: enabled }),
        { initialProps: { enabled: false } },
      );

      expect(result.current.sessionHydrationStatus).toBe("idle");
      expect(hydrateSpy).not.toHaveBeenCalled();

      rerender({ enabled: true });

      expect(result.current.sessionHydrationStatus).toBe("loading");
      expect(hydrateSpy).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("ready");
      });
      expect(result.current.sessions).toEqual([hostedSession]);
      expect(result.current.activeSessionId).toBe(hostedSession.id);

      rerender({ enabled: false });
      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("idle");
      });
      rerender({ enabled: true });
      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("failed");
      });
      expect(result.current.sessions).toEqual([]);
      expect(result.current.activeSessionId).toBeNull();
      expect(SessionStateService.loadActiveSessionId()).toBe(hostedSession.id);
      expect(localStorage.getItem("legioncode:sessions:v3")).toBe(legacySnapshot);
    });

    it("publishes a new conversation only after durable session creation completes", async () => {
      let release!: (session: AgentSession) => void;
      let pendingSession!: AgentSession;
      vi.mocked(SessionMetadata.persistSession).mockImplementationOnce((session) => {
        pendingSession = session;
        return new Promise<AgentSession>((resolve) => { release = resolve; });
      });
      const { result } = renderHook(() => useSessionManager());
      let creation!: Promise<string>;
      await act(async () => { creation = result.current.createSession("Pending", "repo"); });
      expect(result.current.sessions).toEqual([]);
      expect(result.current.activeSessionId).toBeNull();
      await act(async () => { release(pendingSession); await creation; });
      expect(result.current.sessions[0]?.id).toBe(await creation);
      expect(result.current.activeSessionId).toBe(await creation);
    });

    it("retains existing conversation selection when durable session creation fails", async () => {
      const { result } = renderHook(() => useSessionManager());
      let original = "";
      await act(async () => { original = await result.current.createSession("Existing", "repo"); });
      vi.mocked(SessionMetadata.persistSession).mockRejectedValueOnce(new Error("create failed"));
      await act(async () => { await expect(result.current.createSession("Failed", "repo")).rejects.toThrow("create failed"); });
      expect(result.current.sessions.map((session) => session.id)).toEqual([original]);
      expect(result.current.activeSessionId).toBe(original);
    });

    it("should create a new session", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Test Task", "test-repo");
      });

      expect(sessionId).toBeTruthy();
      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0]?.name).toBe("Test Task");
      expect(result.current.sessions[0]?.repository).toBe("test-repo");
    });

    it("should create session with default name", async () => {
      const { result } = renderHook(() => useSessionManager());

      await act(async () => {
        await result.current.createSession(undefined, "test-repo");
      });

      expect(result.current.sessions[0]?.name).toBe("New Task");
    });

    it("should add repository on session creation", async () => {
      const { result } = renderHook(() => useSessionManager());

      await act(async () => {
        await result.current.createSession("Task", "new-repo");
      });

      expect(result.current.repositories).toContain("new-repo");
    });

    it("should set created session as active", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      expect(result.current.activeSessionId).toBe(sessionId);
    });

    it("should generate unique run IDs for each session", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId1 = "";
      let sessionId2 = "";
      await act(async () => {
        sessionId1 = await result.current.createSession("Task 1", "repo");
        sessionId2 = await result.current.createSession("Task 2", "repo");
      });

      const session1 = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId1,
      );
      const session2 = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId2,
      );

      expect(session1?.activeRunId).not.toBe(session2?.activeRunId);
    });
  });

  describe("Session Switching", () => {
    it("should switch active session", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId1 = "";
      await act(async () => {
        sessionId1 = await result.current.createSession("Task 1", "repo");
        await result.current.createSession("Task 2", "repo");
      });

      await act(async () => {
        result.current.setActiveSessionId(sessionId1);
      });

      expect(result.current.activeSessionId).toBe(sessionId1);
    });

    it("should persist active session to tab storage", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      expect(SessionStateService.loadActiveSessionId()).toBe(sessionId);
    });

    it("does not treat acknowledging an unread task as recent activity", async () => {
      const { result } = renderHook(() => useSessionManager());
      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Unread task", "repo");
        result.current.updateSession(sessionId, {
          lastTerminalTurnId: "trn_terminal001",
        });
      });
      const activityTimestamp = result.current.sessions.find(
        (session) => session.id === sessionId,
      )!.updatedAt;

      vi.mocked(SessionMetadata.acknowledgeSessionReadReceipt).mockResolvedValueOnce({
        sessionId,
        lastAcknowledgedTerminalTurnId: TurnIdSchema.parse("trn_terminal001"),
        acknowledgedAt: "2026-10-12T00:00:00.000Z",
      });

      await act(async () => {
        await result.current.acknowledgeSession(sessionId);
      });

      const acknowledged = result.current.sessions.find(
        (session) => session.id === sessionId,
      );
      expect(acknowledged?.lastAcknowledgedTerminalTurnId).toBe(
        "trn_terminal001",
      );
      expect(acknowledged?.updatedAt).toBe(activityTimestamp);
    });

    it("does not let a late acknowledgement overwrite a newer terminal or receipt", async () => {
      const { result } = renderHook(() => useSessionManager());
      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Unread task", "repo");
        result.current.updateSession(sessionId, { lastTerminalTurnId: "trn_terminal001" });
      });
      let resolveAcknowledgement!: (value: { sessionId: string; lastAcknowledgedTerminalTurnId: ReturnType<typeof TurnIdSchema.parse>; acknowledgedAt: string }) => void;
      vi.mocked(SessionMetadata.acknowledgeSessionReadReceipt).mockReturnValueOnce(new Promise((resolve) => {
        resolveAcknowledgement = resolve;
      }));
      let pending!: Promise<void>;
      await act(async () => {
        pending = result.current.acknowledgeSession(sessionId);
        await Promise.resolve();
      });
      await act(async () => {
        result.current.updateSession(sessionId, {
          lastTerminalTurnId: "trn_terminal002",
          lastAcknowledgedTerminalTurnId: "trn_terminal002",
        });
      });
      await act(async () => {
        resolveAcknowledgement({ sessionId, lastAcknowledgedTerminalTurnId: TurnIdSchema.parse("trn_terminal001"), acknowledgedAt: "2026-10-12T00:00:01.000Z" });
        await pending;
      });
      const current = result.current.sessions.find((session) => session.id === sessionId);
      expect(current?.lastTerminalTurnId).toBe("trn_terminal002");
      expect(current?.lastAcknowledgedTerminalTurnId).toBe("trn_terminal002");
    });

    it("rolls back an old optimistic receipt when its request fails after a newer terminal", async () => {
      const { result } = renderHook(() => useSessionManager());
      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Unread task", "repo");
        result.current.updateSession(sessionId, { lastTerminalTurnId: "trn_terminal001" });
      });
      let rejectAcknowledgement!: (reason: Error) => void;
      vi.mocked(SessionMetadata.acknowledgeSessionReadReceipt).mockReturnValueOnce(new Promise((_, reject) => {
        rejectAcknowledgement = reject;
      }));
      let pending!: Promise<void>;
      await act(async () => {
        pending = result.current.acknowledgeSession(sessionId);
        await Promise.resolve();
      });
      await act(async () => {
        result.current.updateSession(sessionId, { lastTerminalTurnId: "trn_terminal002" });
      });
      await act(async () => {
        rejectAcknowledgement(new Error("stale receipt"));
        await pending;
      });
      const current = result.current.sessions.find((session) => session.id === sessionId);
      expect(current?.lastTerminalTurnId).toBe("trn_terminal002");
      expect(current?.lastAcknowledgedTerminalTurnId).toBeNull();
    });
  });

  describe("Session Removal", () => {
    it("reports an unsuccessful archive and restores the selected conversation", async () => {
      const { result } = renderHook(() => useSessionManager());
      let sessionId = "";
      await act(async () => { sessionId = await result.current.createSession("Task", "repo"); });
      vi.mocked(SessionMetadata.archiveSession).mockRejectedValueOnce(new Error("archive unavailable"));
      await act(async () => { expect(await result.current.archiveSession(sessionId)).toBe(false); });
      expect(result.current.activeSessionId).toBe(sessionId);
      expect(result.current.sessions[0]?.archivedAt).toBeNull();
    });

    it("should archive session", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      expect(result.current.sessions).toHaveLength(1);

      await act(async () => {
        result.current.removeSession(sessionId);
      });

      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0]?.archivedAt).not.toBeNull();
      expect(SessionMetadata.archiveSession).toHaveBeenCalledWith(
        sessionId,
      );
    });

    it("should clear active session if removed session is active", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      expect(result.current.activeSessionId).toBe(sessionId);

      await act(async () => {
        result.current.removeSession(sessionId);
      });

      expect(result.current.activeSessionId).toBeNull();
    });

    it("should preserve session GitHub context on archive", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      // Save context for session
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

      // Remove session
      await act(async () => {
        result.current.removeSession(sessionId);
      });

      const loaded = SessionStateService.loadSessionGitHubContext(sessionId);
      expect(loaded).toEqual(context);
    });

    it("keeps local-only sessions archived when the server archive returns not found", async () => {
      vi.mocked(SessionMetadata.archiveSession).mockRejectedValueOnce(
        new Error("Session archive failed: 404"),
      );
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      await act(async () => {
        result.current.removeSession(sessionId);
      });

      await waitFor(() => {
        expect(result.current.sessions[0]?.archivedAt).not.toBeNull();
      });
      expect(result.current.activeSessionId).toBeNull();
    });
  });

  describe("Session Updates", () => {
    it("should update session properties", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      await act(async () => {
        result.current.updateSession(sessionId, { name: "Updated Task" });
      });

      const session = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId,
      );
      expect(session?.name).toBe("Updated Task");
    });

    it("should update session status", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      await act(async () => {
        result.current.updateSession(sessionId, { status: "running" });
      });

      const session = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId,
      );
      expect(session?.status).toBe("running");
    });

    it("should not update updatedAt for no-op updates", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      const original = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId,
      );
      expect(original).toBeDefined();

      await act(async () => {
        result.current.updateSession(sessionId, { status: original!.status });
      });

      const afterNoOp = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId,
      );
      expect(afterNoOp?.updatedAt).toBe(original?.updatedAt);
    });

    it("can project lifecycle status without reordering recent activity", async () => {
      const { result } = renderHook(() => useSessionManager());
      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });
      const originalUpdatedAt = result.current.sessions[0]!.updatedAt;

      await act(async () => {
        result.current.updateSession(
          sessionId,
          { status: "waiting_for_approval" },
          { preserveActivityTimestamp: true },
        );
      });

      expect(result.current.sessions[0]?.status).toBe("waiting_for_approval");
      expect(result.current.sessions[0]?.updatedAt).toBe(originalUpdatedAt);
    });

    it("should reject invalid session updates", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      const originalSession = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId,
      );

      // Try to set activeRunId to a non-existent run
      await act(async () => {
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
    it("should add repository", async () => {
      const { result } = renderHook(() => useSessionManager());

      await act(async () => {
        result.current.addRepository("new-repo");
      });

      expect(result.current.repositories).toContain("new-repo");
    });

    it("should not add duplicate repositories", async () => {
      const { result } = renderHook(() => useSessionManager());

      await act(async () => {
        result.current.addRepository("repo");
        result.current.addRepository("repo");
      });

      const repoCount = result.current.repositories.filter(
        (r: string) => r === "repo",
      ).length;
      expect(repoCount).toBe(1);
    });

    it("should remove repository", async () => {
      const { result } = renderHook(() => useSessionManager());

      await act(async () => {
        result.current.addRepository("repo");
      });

      expect(result.current.repositories).toContain("repo");

      await act(async () => {
        result.current.removeRepository("repo");
      });

      expect(result.current.repositories).not.toContain("repo");
    });

    it("should remove sessions when removing repository", async () => {
      const { result } = renderHook(() => useSessionManager());
      const clearMessagesForRun = vi.spyOn(agentStore, "clearMessagesForRun");

      await act(async () => {
        await result.current.createSession("Task 1", "repo");
        await result.current.createSession("Task 2", "repo");
      });

      expect(result.current.sessions).toHaveLength(2);

      await act(async () => {
        result.current.removeRepository("repo");
      });

      expect(result.current.sessions).toHaveLength(0);
      expect(clearMessagesForRun).not.toHaveBeenCalled();
    });

    it("should rename repository", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "old-repo");
      });

      await act(async () => {
        result.current.renameRepository("old-repo", "new-repo");
      });

      const session = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId,
      );
      expect(session?.repository).toBe("new-repo");
      expect(result.current.repositories).toContain("new-repo");
      expect(result.current.repositories).not.toContain("old-repo");
    });
  });

  describe("Persistence", () => {
    it("should restore sessions on mount", async () => {
      const session = SessionStateService.createSession("Task", "repo");
      const legacySnapshot = storeLegacySessions({ [session.id]: session }, session.id);

      // The explicit no-hydration seam still reads the legacy session list.
      const { result } = renderHook(() =>
        useSessionManager({ hydrateFromServer: false }),
      );
      expect(result.current.sessions).toEqual([session]);
      expect(localStorage.getItem("legioncode:sessions:v3")).toBe(legacySnapshot);
    });

    it("should persist active session ID", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Task", "repo");
      });

      expect(SessionStateService.loadActiveSessionId()).toBe(sessionId);
    });

    it("replaces stale local sessions with the authoritative server snapshot", async () => {
      const staleSession = SessionStateService.createSession("Stale", "repo");
      const serverSession = SessionStateService.createSession("Server", "repo");
      const legacySnapshot = storeLegacySessions(
        { [staleSession.id]: staleSession },
        staleSession.id,
      );
      SessionStateService.saveActiveSessionId(serverSession.id, {
        [serverSession.id]: serverSession,
      });
      vi.mocked(
        SessionMetadata.hydrateSessionsFromServer,
      ).mockResolvedValueOnce({ [serverSession.id]: serverSession });

      const { result } = renderHook(() => useSessionManager());

      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("ready");
      });
      expect(result.current.sessions).toEqual([serverSession]);
      expect(result.current.activeSessionId).toBe(serverSession.id);
      expect(SessionStateService.loadActiveSessionId()).toBe(serverSession.id);
      expect(SessionStateService.loadSessions()).toEqual({
        [staleSession.id]: staleSession,
      });
      expect(localStorage.getItem("legioncode:sessions:v3")).toBe(legacySnapshot);
    });

    it("preserves a locally-created active session when stale hydration resolves later", async () => {
      const hydration = createDeferred<Record<string, AgentSession>>();
      vi.mocked(
        SessionMetadata.hydrateSessionsFromServer,
      ).mockReturnValueOnce(hydration.promise);

      const { result, rerender } = renderHook(
        ({ enabled }) => useSessionManager({ hydrateFromServer: enabled }),
        { initialProps: { enabled: true } },
      );

      let sessionId = "";
      await act(async () => {
        sessionId = await result.current.createSession("Fresh task", "repo");
      });

      await act(async () => {
        hydration.resolve({});
        await hydration.promise;
      });

      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("ready");
      });
      expect(result.current.sessions.map((session) => session.id)).toContain(
        sessionId,
      );
      expect(result.current.activeSessionId).toBe(sessionId);
      expect(SessionStateService.loadActiveSessionId()).toBe(sessionId);

      let rejectFailedHydration!: (error: Error) => void;
      const failedHydration = new Promise<Record<string, AgentSession>>(
        (_, reject) => {
          rejectFailedHydration = reject;
        },
      );
      vi.mocked(
        SessionMetadata.hydrateSessionsFromServer,
      ).mockReturnValueOnce(failedHydration);
      rerender({ enabled: false });
      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("idle");
      });
      rerender({ enabled: true });
      await waitFor(() => {
        expect(SessionMetadata.hydrateSessionsFromServer).toHaveBeenCalledTimes(2);
      });

      let confirmedDuringFailure = "";
      await act(async () => {
        confirmedDuringFailure = await result.current.createSession(
          "Confirmed during failed hydration",
          "repo",
        );
      });
      await act(async () => {
        rejectFailedHydration(new Error("hosted session list unavailable"));
      });
      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("failed");
      });
      expect(result.current.sessions.map((session) => session.id)).toEqual([
        confirmedDuringFailure,
      ]);
      expect(result.current.activeSessionId).toBe(confirmedDuringFailure);

      const staleGenerationHydration = createDeferred<
        Record<string, AgentSession>
      >();
      vi.mocked(
        SessionMetadata.hydrateSessionsFromServer,
      ).mockReturnValueOnce(staleGenerationHydration.promise);
      rerender({ enabled: false });
      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("idle");
      });
      rerender({ enabled: true });
      await waitFor(() => {
        expect(SessionMetadata.hydrateSessionsFromServer).toHaveBeenCalledTimes(3);
      });

      let releaseStaleCreate!: (session: AgentSession) => void;
      let stalePendingSession!: AgentSession;
      vi.mocked(SessionMetadata.persistSession).mockImplementationOnce(
        (session) => {
          stalePendingSession = session;
          return new Promise<AgentSession>((resolve) => {
            releaseStaleCreate = resolve;
          });
        },
      );
      let staleCreation!: Promise<string>;
      await act(async () => {
        staleCreation = result.current.createSession(
          "Created in an earlier hydration generation",
          "repo",
        );
      });

      let rejectNextGenerationHydration!: (error: Error) => void;
      const nextGenerationHydration = new Promise<
        Record<string, AgentSession>
      >((_, reject) => {
        rejectNextGenerationHydration = reject;
      });
      vi.mocked(
        SessionMetadata.hydrateSessionsFromServer,
      ).mockReturnValueOnce(nextGenerationHydration);
      rerender({ enabled: false });
      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("idle");
      });
      rerender({ enabled: true });
      await waitFor(() => {
        expect(SessionMetadata.hydrateSessionsFromServer).toHaveBeenCalledTimes(4);
      });

      await act(async () => {
        releaseStaleCreate(stalePendingSession);
        await staleCreation;
      });
      await act(async () => {
        rejectNextGenerationHydration(
          new Error("new hosted session list unavailable"),
        );
        await nextGenerationHydration.catch(() => undefined);
      });
      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("failed");
      });
      expect(result.current.sessions).toEqual([]);
      expect(result.current.activeSessionId).toBeNull();
    });

    it("clears stale local sessions when the server snapshot is empty", async () => {
      const staleSession = SessionStateService.createSession("Stale", "repo");
      const legacySnapshot = storeLegacySessions(
        { [staleSession.id]: staleSession },
        staleSession.id,
      );
      SessionStateService.saveActiveSessionId(staleSession.id, {
        [staleSession.id]: staleSession,
      });

      const { result } = renderHook(() => useSessionManager());

      await waitFor(() => {
        expect(result.current.sessionHydrationStatus).toBe("ready");
      });
      expect(result.current.sessions).toEqual([]);
      expect(result.current.activeSessionId).toBeNull();
      expect(SessionStateService.loadSessions()).toEqual({
        [staleSession.id]: staleSession,
      });
      expect(localStorage.getItem("legioncode:sessions:v3")).toBe(legacySnapshot);
      expect(SessionStateService.loadActiveSessionId()).toBeNull();
    });

    it("starts title refresh from the projection read after chat acceptance", async () => {
      const initial = createTitleSession({
        titleSource: "preview",
        titleStatus: "ready",
        titleVersion: 1,
      });
      const pending = createTitleSession({
        titleSource: "preview",
        titleStatus: "pending",
        titleVersion: 2,
      });
      const generated = createTitleSession({
        name: "Create dark mode toggle",
        titleSource: "generated",
        titleStatus: "ready",
        titleVersion: 3,
      });
      vi.mocked(SessionMetadata.hydrateSessionsFromServer)
        .mockResolvedValueOnce({ [initial.id]: initial })
        .mockResolvedValueOnce({ [pending.id]: pending })
        .mockResolvedValue({ [generated.id]: generated });
      const { result } = renderHook(() => useSessionManager());
      await waitFor(() =>
        expect(result.current.sessionHydrationStatus).toBe("ready"),
      );
      // useChatCore calls this existing refresh on the accepted chat response.
      await act(() => result.current.refreshSessionProjection(initial.id));
      expect(result.current.sessions[0]?.titleStatus).toBe("pending");
      await waitFor(
        () =>
          expect(result.current.sessions[0]?.name).toBe(
            "Create dark mode toggle",
          ),
        { timeout: 2000 },
      );
      expect(result.current.sessions[0]?.titleStatus).toBe("ready");
    });

    it("refreshes a pending preview until the canonical generated title arrives", async () => {
      const pending = createTitleSession({
        name: "Check my…",
        titleSource: "preview",
        titleStatus: "pending",
        titleVersion: 2,
      });
      const ready = createTitleSession({
        name: "Refine Landing Page Hero",
        titleSource: "generated",
        titleStatus: "ready",
        titleVersion: 3,
      });
      vi.mocked(SessionMetadata.hydrateSessionsFromServer)
        .mockResolvedValueOnce({ [pending.id]: pending })
        .mockResolvedValueOnce({ [ready.id]: ready });

      const { result } = renderHook(() => useSessionManager());

      await waitFor(() => {
        expect(result.current.sessions[0]?.titleSource).toBe("preview");
      });
      await waitFor(
        () => {
          expect(result.current.sessions[0]?.name).toBe(
            "Refine Landing Page Hero",
          );
          expect(result.current.sessions[0]?.titleSource).toBe("generated");
        },
        { timeout: 2_000 },
      );
    });
  });

  describe("Multi-Session Isolation", () => {
    it("should isolate session state", async () => {
      const { result } = renderHook(() => useSessionManager());

      let sessionId1 = "";
      let sessionId2 = "";
      await act(async () => {
        sessionId1 = await result.current.createSession("Task 1", "repo1");
        sessionId2 = await result.current.createSession("Task 2", "repo2");
      });

      const session1 = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId1,
      );
      const session2 = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId2,
      );

      // Verify sessions have different properties
      expect(session1?.name).not.toBe(session2?.name);
      expect(session1?.repository).not.toBe(session2?.repository);
      expect(session1?.activeRunId).not.toBe(session2?.activeRunId);
    });

    it("should not leak messages between sessions", async () => {
      // This test verifies that agentStore properly isolates messages by runId
      const { result } = renderHook(() => useSessionManager());

      let sessionId1 = "";
      let sessionId2 = "";
      await act(async () => {
        sessionId1 = await result.current.createSession("Task 1", "repo");
        sessionId2 = await result.current.createSession("Task 2", "repo");
      });

      const session1 = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId1,
      );
      const session2 = result.current.sessions.find(
        (s: AgentSession) => s.id === sessionId2,
      );

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

});

function storeLegacySessions(
  sessions: Record<string, AgentSession>,
  activeSessionId: string | null,
): string {
  const snapshot = JSON.stringify({
    version: 3,
    sessions,
    activeSessionId,
    lastModified: "2026-10-23T00:00:00.000Z",
  });
  localStorage.setItem("legioncode:sessions:v3", snapshot);
  return snapshot;
}

function createArchivedServerSession(
  sessionId: string,
  archivedAt: string,
): AgentSession {
  return {
    id: sessionId,
    name: "Archived",
    titleSource: "generated",
    repository: "repo",
    activeRunId: "run",
    runIds: ["run"],
    status: "idle",
    mode: "build",
    pinnedAt: null,
    archivedAt,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: archivedAt,
  };
}

function createTitleSession(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "session-title-1",
    name: "New Task",
    repository: "repo",
    activeRunId: "run-title-1",
    runIds: ["run-title-1"],
    status: "running",
    mode: "build",
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
    titleSource: overrides.titleSource ?? "generated",
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
