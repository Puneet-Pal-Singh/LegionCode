import { beforeEach, describe, expect, it } from "vitest";
import {
  MemoryEventStore,
  MemoryThreadTitleRepository,
  MemoryRunRepository,
  MemoryTranscriptRepository,
} from "@repo/persistence";
import { TranscriptController } from "./TranscriptController";
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
    const createResponse = await TranscriptController.createSession(
      createSessionRequest(),
      env,
    );

    const listResponse = await TranscriptController.listSessions(
      authenticatedRequest("https://brain.local/api/sessions"),
      env,
    );

    expect(createResponse.status).toBe(201);
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
    await TranscriptController.createSession(createSessionRequest(), env);

    const archiveResponse = await TranscriptController.archiveSession(
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/archive`,
        { method: "POST" },
      ),
      env,
    );
    const listResponse = await TranscriptController.listSessions(
      authenticatedRequest("https://brain.local/api/sessions"),
      env,
    );

    expect(archiveResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      sessions: [],
    });
  });

  it("renames, pins, and unarchives session metadata", async () => {
    await TranscriptController.createSession(createSessionRequest(), env);
    await ensureCanonicalTitleScope(repository);

    const renameResponse = await TranscriptController.renameSessionTitle(
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/title`,
        {
          method: "PATCH",
          body: JSON.stringify({ title: "Custom Chat" }),
        },
      ),
      env,
    );
    const pinResponse = await TranscriptController.pinSession(
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/pin`,
        { method: "POST" },
      ),
      env,
    );
    const archiveResponse = await TranscriptController.archiveSession(
      authenticatedRequest(
        `https://brain.local/api/sessions/${TEST_SESSION_ID}/archive`,
        { method: "POST" },
      ),
      env,
    );
    const archivedListResponse =
      await TranscriptController.listArchivedSessions(
        authenticatedRequest("https://brain.local/api/sessions/archived"),
        env,
      );
    const unarchiveResponse = await TranscriptController.unarchiveSession(
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
    await TranscriptController.createSession(createSessionRequest(), env);
    await ensureCanonicalTitleScope(repository);

    const response = await TranscriptController.renameSessionTitle(
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      session: { title: "Generated from prompt", titleSource: "user" },
    });
  });

  it("rejects a rename until the session has a persisted canonical title scope", async () => {
    await TranscriptController.createSession(createSessionRequest(), env);

    const response = await TranscriptController.renameSessionTitle(
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

    const response = await TranscriptController.getHistory(
      authenticatedRequest(
        `https://brain.local/api/chat/history?runId=${TEST_RUN_ID}&session=${TEST_SESSION_ID}`,
      ),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      messages: [
        {
          id: "client-user-1",
          role: "user",
          content: "hello",
        },
      ],
    });
  });

  it("hydrates assistant activity parts and terminal metadata", async () => {
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

    const response = await TranscriptController.getHistory(
      authenticatedRequest(
        `https://brain.local/api/chat/history?runId=${TEST_RUN_ID}&session=${TEST_SESSION_ID}`,
      ),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      messages: [
        {
          id: "client-assistant-1",
          role: "assistant",
          data: {
            metadata: { terminalState: "completed" },
            activityParts: [
              {
                type: "turn_activity",
                events: [],
                activitySnapshot: {
                  items: [{ label: "Read files" }],
                },
              },
            ],
          },
        },
      ],
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
      Cookie: "shadowbox_session=test-token",
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
