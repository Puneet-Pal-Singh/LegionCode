import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as SessionMetadata from "./sessionMetadata";
import { SessionStateService } from "../SessionStateService";
import { _resetEndpointCache } from "../../lib/platform-endpoints";

describe("hosted session metadata presentation", () => {
  beforeEach(() => { _resetEndpointCache(); localStorage.clear(); sessionStorage.clear(); });
  afterEach(() => { _resetEndpointCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
  describe("Server Session Hydration", () => {
    it("hydrates canonical sessions from Brain", async () => {
      const warnSpy = silenceConsoleWarn();
      const fetchMock = vi.fn().mockResolvedValue(
        metadataResponse("session/list",
          JSON.stringify({
            sessions: [
              {
                id: "550e8400-e29b-41d4-a716-446655440000",
                title: "Server Task",
                repository: "acme/legioncode",
                activeRunId: "run_550e8400e29b41d4a716446655440001",
                mode: "build",
                status: "failed",
                createdAt: "2026-05-14T00:00:00.000Z",
                updatedAt: "2026-05-15T00:00:00.000Z",
              },
            ],
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const sessions = await SessionMetadata.hydrateSessionsFromServer();

      const session = sessions["550e8400-e29b-41d4-a716-446655440000"];
      expect(session?.name).toBe("Server Task");
      expect(session?.status).toBe("failed");
      expect(session?.createdAt).toBe("2026-05-14T00:00:00.000Z");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/app-server/request"),
        expect.objectContaining({ credentials: "include", method: "POST" }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[platform-endpoints] VITE_BRAIN_BASE_URL not set, using default:",
        `${window.location.origin}/__legioncode/brain`,
      );
    });

    it("hydrates canonical title source and version for generated-title replay", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          metadataResponse("session/list",
            JSON.stringify({
              sessions: [
                {
                  id: "550e8400-e29b-41d4-a716-446655440000",
                  title: "Refine Landing Page Hero",
                  titleSource: "generated",
                  titleVersion: 3,
                  repository: "acme/legioncode",
                  activeRunId: "run_550e8400e29b41d4a716446655440001",
                  mode: "build",
                  status: "completed",
                  createdAt: "2026-05-14T00:00:00.000Z",
                  updatedAt: "2026-05-15T00:00:00.000Z",
                },
              ],
            }),
          ),
        ),
      );

      const sessions = await SessionMetadata.hydrateSessionsFromServer();

      expect(sessions["550e8400-e29b-41d4-a716-446655440000"]).toMatchObject({
        name: "Refine Landing Page Hero",
        titleSource: "generated",
        titleVersion: 3,
      });
    });

    it("keeps server sessions that still use legacy UUID run ids", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          metadataResponse("session/list",
            JSON.stringify({
              sessions: [
                {
                  id: "550e8400-e29b-41d4-a716-446655440000",
                  title: "Legacy Task",
                  repository: "acme/legioncode",
                  activeRunId: "550e8400-e29b-41d4-a716-446655440001",
                  mode: "build",
                  status: "running",
                  createdAt: "2026-05-14T00:00:00.000Z",
                  updatedAt: "2026-05-15T00:00:00.000Z",
                },
              ],
            }),
          ),
        ),
      );

      await expect(SessionMetadata.hydrateSessionsFromServer()).resolves.toMatchObject({
        "550e8400-e29b-41d4-a716-446655440000": {
          id: "550e8400-e29b-41d4-a716-446655440000",
          activeRunId: null,
          persistenceStatus: "saved",
        },
      });
    });

    it("persists created sessions to Brain", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        metadataResponse("session/create", JSON.stringify({ session: createServerSession("Task") }), {
          status: 201,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const session = SessionStateService.createSession("Task", "repo");

      await SessionMetadata.persistSession(session);

      const [, requestInit] = fetchMock.mock.calls[0] ?? [];
      const body = JSON.parse(String(requestInit?.body));
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/app-server/request"),
        expect.objectContaining({
          method: "POST",
          credentials: "include",
        }),
      );
      expect(body).toMatchObject({ method: "session/create" });
      expect(body.params).toMatchObject({
        sessionId: session.id,
        runId: session.activeRunId,
      });
    });

    it("archives sessions through Brain", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        metadataResponse("session/archive", JSON.stringify({ session: createServerSession("Task") }), {
          status: 200,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await SessionMetadata.archiveSession(
        "550e8400-e29b-41d4-a716-446655440000",
      );

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "/app-server/request",
        ),
        expect.objectContaining({ method: "POST", credentials: "include" }),
      );
    });

    it("persists a session without inventing missing run or repository identity", async () => {
      const fetchMock = vi.fn().mockResolvedValue(metadataResponse("session/create", JSON.stringify({
        session: { ...createServerSession("Saved task"), activeRunId: null, repository: null },
      })));
      vi.stubGlobal("fetch", fetchMock);
      const session = { ...SessionStateService.createSession("Saved task", "repo"), repository: null, activeRunId: null, runIds: [] };
      const saved = await SessionMetadata.persistSession(session);
      const envelope = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(envelope.params).toEqual({ sessionId: session.id, title: "Saved task", mode: "build" });
      expect(saved.activeRunId).toBeNull();
      expect(saved.runIds).toEqual([]);
    });
  });

});

function createServerSession(title: string) {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    title,
    titleSource: "generated",
    repository: "repo",
    activeRunId: "run_550e8400e29b41d4a716446655440001",
    mode: "build",
    status: "idle",
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}

function silenceConsoleWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

function metadataResponse(method: string, body: string, init?: ResponseInit) {
  const result = JSON.parse(body);
  const complete = (session: Record<string, unknown>) => ({
    userId: "550e8400-e29b-41d4-a716-446655440099", workspaceId: null, threadId: null,
    taskId: session.id, titleSource: "preview", pinnedAt: null, archivedAt: null, ...session,
  });
  if (result.sessions) { result.sessions = result.sessions.map(complete); result.tasks = []; }
  if (result.session) result.session = complete(result.session);
  return new Response(JSON.stringify({ protocolVersion: "1.0.0", method, ok: true, result }), init);
}
