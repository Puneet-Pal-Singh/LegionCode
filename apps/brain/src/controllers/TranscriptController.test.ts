import { beforeEach, describe, expect, it } from "vitest";
import { MemoryTranscriptRepository } from "@repo/persistence";
import { TranscriptController } from "./TranscriptController";
import type { Env } from "../types/ai";

const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440001";
const TEST_RUN_ID = "550e8400-e29b-41d4-a716-446655440002";

describe("TranscriptController", () => {
  let repository: MemoryTranscriptRepository;
  let env: Env;

  beforeEach(() => {
    repository = new MemoryTranscriptRepository({
      now: () => new Date("2026-05-15T00:00:00.000Z"),
    });
    env = createEnv(repository);
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

  it("hydrates transcript messages in session sequence order", async () => {
    await repository.appendMessage({
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
      userId: TEST_USER_ID,
      title: "Task",
      activeRunId: TEST_RUN_ID,
      status: "running",
      role: "user",
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
          role: "user",
          content: "hello",
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

function authenticatedRequest(
  url: string,
  init: RequestInit = {},
): Request {
  return new Request(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: "shadowbox_session=test-token",
      ...(init.headers ?? {}),
    },
  });
}

function createEnv(repository: MemoryTranscriptRepository): Env {
  return {
    AI: {} as Env["AI"],
    AUTH_TRANSCRIPT_REPOSITORY: repository,
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
  };
}
