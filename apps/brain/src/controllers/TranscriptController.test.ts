import { AppServerController } from "./AppServerController";
import { APP_SERVER_PROTOCOL_VERSION, type AppServerMethod } from "@legioncode/app-server/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MemoryEventStore,
  MemoryThreadTitleRepository,
  MemoryRunRepository,
  MemoryTranscriptRepository,
  MemoryWorkspaceRepository,
} from "@repo/persistence";
import type { Env } from "../types/ai";

const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440001";
const TEST_RUN_ID = "run_550e8400e29b41d4a716446655440002";
const TEST_WORKSPACE_ID = "default";

describe("TranscriptController", () => {
  let repository: MemoryTranscriptRepository;
  let runRepository: MemoryRunRepository;
  let titleEvents: MemoryEventStore;
  let env: Env;

  beforeEach(() => {
    repository = new MemoryTranscriptRepository({
      now: () => new Date("2026-05-15T00:00:00.000Z"),
    });
    runRepository = new MemoryRunRepository({
      now: () => new Date("2026-05-15T00:00:00.000Z"),
    });
    titleEvents = new MemoryEventStore({
      now: () => "2026-05-15T00:00:00.000Z",
    });
    env = createEnv(repository, runRepository, titleEvents);
  });

  it("creates and lists authenticated sessions from the transcript repository", async () => {
    const createResponse = await requestHostedSession("session/create",
      createSessionRequest(),
      env,
    );

    const listResponse = await requestHostedSession("session/list",
      authenticatedRequest("https://brain.local/api/sessions"),
      env,
    );

    expect(createResponse.status).toBe(200);
    await expect(
      runRepository.getRun(TEST_RUN_ID, TEST_USER_ID),
    ).resolves.toMatchObject({
      id: TEST_RUN_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      taskId: TEST_SESSION_ID,
      status: "created",
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      sessions: [
        {
          id: TEST_SESSION_ID,
          userId: TEST_USER_ID,
          activeRunId: TEST_RUN_ID,
        },
      ],
    });
  });

  it("archives sessions so they no longer hydrate", async () => {
    await requestHostedSession("session/create", createSessionRequest(), env);

    const archiveResponse = await requestHostedSession("session/archive",
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/archive`,
        { method: "POST" },
      ),
      env,
    );
    const listResponse = await requestHostedSession("session/list",
      authenticatedRequest("https://brain.local/api/sessions"),
      env,
    );

    expect(archiveResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      sessions: [],
    });
  });

  it("permanently deletes only authenticated archived sessions", async () => {
    await requestHostedSession("session/create", createSessionRequest(), env);

    const activeDelete = await requestHostedSession("session/delete",
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}`,
        { method: "DELETE" },
      ),
      env,
    );
    await requestHostedSession("session/archive",
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/archive`,
        { method: "POST" },
      ),
      env,
    );
    const deleted = await requestHostedSession("session/delete",
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}`,
        { method: "DELETE" },
      ),
      env,
    );

    expect(activeDelete.status).toBe(404);
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ deleted: true });
    await expect(repository.listArchivedSessions(TEST_USER_ID)).resolves.toEqual(
      [],
    );
  });

  it("renames, pins, and unarchives session metadata", async () => {
    await requestHostedSession("session/create", createSessionRequest(), env);
    await ensureCanonicalTitleScope(repository);

    const renameResponse = await requestHostedSession("session/rename",
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/title`,
        {
          method: "PATCH",
          body: JSON.stringify({ title: "Custom Chat" }),
        },
      ),
      env,
    );
    const pinResponse = await requestHostedSession("session/pin",
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/pin`,
        { method: "POST" },
      ),
      env,
    );
    const archiveResponse = await requestHostedSession("session/archive",
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/archive`,
        { method: "POST" },
      ),
      env,
    );
    const archivedListResponse =
      await requestHostedSession("session/archived",
        authenticatedRequest("https://brain.local/api/sessions/archived"),
        env,
      );
    const unarchiveResponse = await requestHostedSession("session/unarchive",
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/unarchive`,
        { method: "POST" },
      ),
      env,
    );

    expect(renameResponse.status).toBe(200);
    await expect(renameResponse.json()).resolves.toMatchObject({
      session: { title: "Custom Chat", titleSource: "user" },
    });
    await expect(
      titleEvents.replay({
        scope: { scopeType: "thread", scopeId: "thr_title_scope" },
        afterCursor: null,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          type: "thread.title.updated",
          payload: expect.objectContaining({
            source: "user",
            title: "Custom Chat",
          }),
        }),
      ],
    });
    expect(pinResponse.status).toBe(200);
    await expect(pinResponse.json()).resolves.toMatchObject({
      session: { pinnedAt: "2026-05-15T00:00:00.000Z" },
    });
    expect(archiveResponse.status).toBe(200);
    await expect(archivedListResponse.json()).resolves.toMatchObject({
      sessions: [
        { id: TEST_SESSION_ID, archivedAt: "2026-05-15T00:00:00.000Z" },
      ],
    });
    expect(unarchiveResponse.status).toBe(200);
    await expect(unarchiveResponse.json()).resolves.toMatchObject({
      session: { archivedAt: null },
    });
  });

  it("does not grant generated title authority to browser requests", async () => {
    await requestHostedSession("session/create", createSessionRequest(), env);
    await ensureCanonicalTitleScope(repository);

    const response = await requestHostedSession("session/rename",
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/title`,
        {
          method: "PATCH",
          body: JSON.stringify({
            title: "Generated from prompt",
            titleSource: "generated",
          }),
        },
      ),
      env,
    );

    expect(response.status).toBe(400);
    const validRename = await requestHostedSession("session/rename", authenticatedRequest(
      `https://brain.local/api/sessions/${TEST_SESSION_ID}/title`, {
        method: "PATCH", body: JSON.stringify({ title: "Generated from prompt" }),
      },
    ), env);
    expect(validRename.status).toBe(200);
    await expect(validRename.json()).resolves.toMatchObject({
      session: { title: "Generated from prompt", titleSource: "user" },
    });
  });

  it("rejects a rename until the session has a persisted canonical title scope", async () => {
    await requestHostedSession("session/create", createSessionRequest(), env);

    const response = await requestHostedSession("session/rename",
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/title`,
        {
          method: "PATCH",
          body: JSON.stringify({ title: "Custom Chat" }),
        },
      ),
      env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "TITLE_SCOPE_UNAVAILABLE",
    });
  });

  it("scopes every session metadata mutation to the verified user", async () => {
    await repository.ensureSession({ sessionId: TEST_SESSION_ID, userId: "another-user" });
    for (const method of ["session/pin", "session/unpin", "session/archive", "session/unarchive", "session/delete"] as const) {
      const response = await requestHostedSession(method, authenticatedRequest(`https://brain.local/api/sessions/${TEST_SESSION_ID}`, { method: "POST" }), env);
      expect(response.status).toBe(404);
    }
    expect((await repository.listSessions("another-user")).sessions).toHaveLength(1);
    const list = await requestHostedSession("session/list", authenticatedRequest("https://brain.local/api/sessions"), env);
    await expect(list.json()).resolves.toMatchObject({ sessions: [] });
  });

  it("rejects an unauthorized workspace before creating session metadata", async () => {
    env.AUTH_WORKSPACE_REPOSITORY = new MemoryWorkspaceRepository();
    const request = authenticatedRequest("https://brain.local/api/sessions", { method: "POST", body: JSON.stringify({
      sessionId: TEST_SESSION_ID, workspaceId: "550e8400-e29b-41d4-a716-446655440099",
    }) });
    const response = await requestHostedSession("session/create", request, env);
    expect(response.status).toBe(404);
    expect((await repository.listSessions(TEST_USER_ID)).sessions).toEqual([]);
  });

  it("does not disclose a saved transcript to an unauthenticated or different user", async () => {
    await repository.ensureSession({ sessionId: TEST_SESSION_ID, userId: "550e8400-e29b-41d4-a716-446655440099" });
    const url = `https://brain.local/api/chat/history?session=${TEST_SESSION_ID}`;
    const unauthenticated = await requestHostedHistory(new Request(url), env);
    const otherUser = await requestHostedHistory(authenticatedRequest(url), env);
    expect(unauthenticated.status).toBe(401);
    expect(otherUser.status).toBe(404);
    await expect(otherUser.json()).resolves.toMatchObject({ ok: false, error: { code: "not_found", message: "Conversation not found" } });
  });

  it("returns a pinned empty transcript and rejects invalid cursor/snapshot requests", async () => {
    await repository.ensureSession({ sessionId: TEST_SESSION_ID, userId: TEST_USER_ID });
    const url = `https://brain.local/api/chat/history?session=${TEST_SESSION_ID}`;
    const empty = await requestHostedHistory(authenticatedRequest(url), env);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({ ok: true, result: { messages: [], nextCursor: null, snapshot: "0" }, method: "session/history", protocolVersion: APP_SERVER_PROTOCOL_VERSION });
    const missingSnapshot = await requestHostedHistory(authenticatedRequest(`${url}&cursor=1`), env);
    const futureSnapshot = await requestHostedHistory(authenticatedRequest(`${url}&snapshot=1`), env);
    expect(missingSnapshot.status).toBe(400);
    expect(futureSnapshot.status).toBe(400);
    await expect(futureSnapshot.json()).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("hydrates transcript messages in session sequence order", async () => {
    await repository.appendMessage({
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
      userId: TEST_USER_ID,
      title: "Task",
      activeRunId: TEST_RUN_ID,
      status: "running",
      role: "user",
      clientMessageId: "client-user-1",
      dedupeKey: "user-message",
      parts: [{ type: "text", content: { text: "hello" } }],
    });

    const response = await requestHostedHistory(
      authenticatedRequest(
        `https://brain.local/api/chat/history?session=${TEST_SESSION_ID}`,
      ),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { messages: [
        {
          id: "client-user-1",
          role: "user",
          content: "hello",
        },
      ] },
    });
  });

  it("hydrates terminal metadata without reconstructing legacy activity parts", async () => {
    await repository.appendMessage({
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
      userId: TEST_USER_ID,
      title: "Task",
      activeRunId: TEST_RUN_ID,
      status: "running",
      role: "assistant",
      clientMessageId: "client-assistant-1",
      dedupeKey: "assistant-message",
      parts: [
        {
          type: "text",
          content: {
            text: "done",
            metadata: { terminalState: "completed" },
          },
        },
        {
          type: "activity",
          content: {
            version: 1,
            type: "turn_activity",
            compacted: false,
            events: [],
            activitySnapshot: {
              runId: TEST_RUN_ID,
              sessionId: TEST_SESSION_ID,
              status: "COMPLETED",
              items: [
                {
                  id: "event-1",
                  runId: TEST_RUN_ID,
                  sessionId: TEST_SESSION_ID,
                  turnId: TEST_RUN_ID,
                  kind: "reasoning",
                  label: "Read files",
                  summary: "Read files",
                  phase: "execution",
                  status: "completed",
                  createdAt: "2026-05-15T00:00:00.000Z",
                  updatedAt: "2026-05-15T00:00:01.000Z",
                  source: "brain",
                },
              ],
            },
          },
        },
      ],
    });

    const response = await requestHostedHistory(
      authenticatedRequest(
        `https://brain.local/api/chat/history?session=${TEST_SESSION_ID}`,
      ),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { messages: [
        {
          id: "client-assistant-1",
          role: "assistant",
          data: {
            metadata: { terminalState: "completed" },
          },
        },
      ] },
    });
  });
});

function createSessionRequest(): Request {
  return authenticatedRequest("https://brain.local/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
      title: "Task",
      repository: "acme/legioncode",
    }),
  });
}

function authenticatedRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: "legioncode_session=test-token",
      ...(init.headers ?? {}),
    },
  });
}

async function ensureCanonicalTitleScope(
  repository: MemoryTranscriptRepository,
): Promise<void> {
  await repository.ensureSession({
    sessionId: TEST_SESSION_ID,
    userId: TEST_USER_ID,
    workspaceId: TEST_WORKSPACE_ID,
    threadId: "thr_title_scope",
    activeRunId: TEST_RUN_ID,
  });
  await repository.appendMessage({
    sessionId: TEST_SESSION_ID,
    runId: TEST_RUN_ID,
    userId: TEST_USER_ID,
    workspaceId: TEST_WORKSPACE_ID,
    role: "user",
    dedupeKey: "first-user-message",
    parts: [{ type: "text", content: "Rename this task" }],
  });
}

function createEnv(
  repository: MemoryTranscriptRepository,
  runRepository: MemoryRunRepository,
  titleEvents: MemoryEventStore,
): Env {
  return {
    AI: {} as Env["AI"],
    AUTH_TRANSCRIPT_REPOSITORY: repository,
    AUTH_RUN_REPOSITORY: runRepository,
    AUTH_THREAD_TITLE_REPOSITORY: new MemoryThreadTitleRepository(
      repository,
      titleEvents,
    ),
    AUTH_IDENTITY_REPOSITORY: {
      createGitHubSession: async () => {
        throw new Error("not used");
      },
      findSessionByHash: async () => createIdentitySessionRecord(),
      findLatestGitHubSessionByUserId: async () =>
        createIdentitySessionRecord(),
      revokeSession: async () => undefined,
    },
    SECURE_API: {
      fetch: async () => new Response(JSON.stringify({ success: true })),
    } as Env["SECURE_API"],
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    GITHUB_REDIRECT_URI: "x",
    GITHUB_TOKEN_ENCRYPTION_KEY: "x",
    SESSION_SECRET: "x",
    FRONTEND_URL: "x",
    SESSIONS: {} as Env["SESSIONS"],
    RUN_ENGINE_RUNTIME: {} as Env["RUN_ENGINE_RUNTIME"],
  } as Env;
}

function createIdentitySessionRecord() {
  return {
    authSessionId: TEST_SESSION_ID,
    userId: TEST_USER_ID,
    login: "puneet",
    avatar: "",
    email: "puneet@example.com",
    name: "Puneet Pal Singh",
    githubScopes: ["repo"],
    encryptedToken: {
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
    },
    createdAt: Date.now(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    workspaceId: TEST_WORKSPACE_ID,
    defaultWorkspaceId: TEST_WORKSPACE_ID,
    workspaceIds: [TEST_WORKSPACE_ID],
  };
}

async function requestHostedHistory(request: Request, env: Env): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  return AppServerController.request(new Request("https://brain.local/app-server/request", {
    method: "POST",
    headers: { ...Object.fromEntries(request.headers), "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "session/history", params: query }),
  }), env);
}

async function requestHostedSession(method: AppServerMethod, request: Request, env: Env): Promise<Response> {
  const body = request.body ? await request.json() as Record<string, unknown> : {};
  const sessionId = new URL(request.url).pathname.match(/^\/api\/sessions\/([^/]+)/)?.[1];
  const params = method === "session/list" || method === "session/archived" ? {}
    : method === "session/create" ? body : { sessionId, ...body };
  const response = await AppServerController.request(new Request("https://brain.local/app-server/request", {
    method: "POST", headers: { ...Object.fromEntries(request.headers), "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method, params }),
  }), env);
  const envelope = await response.json() as { ok: boolean; result?: unknown; error?: unknown };
  expect(envelope).toMatchObject({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method });
  return new Response(JSON.stringify(envelope.ok ? envelope.result : envelope.error), { status: response.status });
}
