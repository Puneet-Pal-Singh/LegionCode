import { describe, expect, it, vi } from "vitest";
import { MemoryTranscriptRepository } from "@repo/persistence";
import { TurnController } from "./TurnController";
import type { Env } from "../types/ai";

const TEST_USER_ID = "user-1";
const TEST_WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174000";
const TEST_RUN_ID = "run_server1";

describe("TurnController public bootstrap contract", () => {
  it("authenticates the request and returns the runtime-issued four-id scope", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = await createEnv(runtime.namespace);

    const response = await TurnController.start(
      createTurnStartRequest({
        Cookie: "legioncode_session=test-session-token",
      }),
      env,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(runtime.identity);
    expect(runtime.idFromName).toHaveBeenCalledWith(TEST_RUN_ID);
    expect(runtime.fetch).toHaveBeenCalledTimes(1);
    const runtimeRequest = runtime.fetch.mock.calls[0]?.[0] as string;
    const runtimeInit = runtime.fetch.mock.calls[0]?.[1] as { body: string };
    expect(new URL(runtimeRequest).pathname).toBe("/turn/start");
    expect(JSON.parse(runtimeInit.body)).toMatchObject({
      runId: TEST_RUN_ID,
      sessionId: "session-1",
      clientMessageId: "client-message-1",
      userId: TEST_USER_ID,
      workspaceId: TEST_WORKSPACE_ID,
    });
  });

  it("rejects an unauthenticated pre-stream request before runtime allocation", async () => {
    const runtime = createMockRuntimeNamespace();

    const response = await TurnController.start(
      createTurnStartRequest(),
      createEnv(runtime.namespace),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "AUTH_FAILED",
    });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });




  });

function createTurnStartRequest(headers?: Record<string, string>): Request {
  return new Request("https://brain.local/turn/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      sessionId: "session-1",
      runId: TEST_RUN_ID,
      clientMessageId: "client-message-1",
    }),
  });
}

function createMockRuntimeNamespace() {
  const identity = {
    workspaceId: TEST_WORKSPACE_ID,
    threadId: "thr_server1",
    turnId: "trn_server1",
    runAttemptId: "attempt_server1",
  };
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(identity), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const idFromName = vi.fn(() => ({ toString: () => "mock-do-id" }));
  const namespace = {
    idFromName,
    get: vi.fn(() => ({ fetch })),
  } as unknown as Env["RUN_ENGINE_RUNTIME"];
  return { namespace, idFromName, fetch, identity };
}

async function createEnv(
  runEngineRuntime: Env["RUN_ENGINE_RUNTIME"],
  options: {
    sessionUserId?: string;
    sessionWorkspaceId?: string;
    executionState?: "pending" | "running" | "recovery_required" | "settled";
  } = {},
): Promise<Env> {
  const transcriptRepository = new MemoryTranscriptRepository();
  await transcriptRepository.ensureSession({
    sessionId: "session-1",
    userId: options.sessionUserId ?? TEST_USER_ID,
    workspaceId: options.sessionWorkspaceId ?? TEST_WORKSPACE_ID,
    title: "fixture",
    threadId: null,
  });
  const admission = {
    userId: TEST_USER_ID,
    sessionId: "session-1",
    clientMessageId: "client-message-1",
    threadId: "thr_server1",
    turnId: "trn_server1",
    runAttemptId: "attempt_server1",
    runId: TEST_RUN_ID,
    workspaceId: TEST_WORKSPACE_ID,
    revisionOfTurnId: null,
    state: "admitted",
    executionState: options.executionState ?? "pending",
    requestFingerprint: "fixture-fingerprint",
    admissionOrder: 1,
    createdAt: new Date(0).toISOString(),
    admittedAt: new Date(0).toISOString(),
  } as const;
  return {
    AI: {} as Env["AI"],
    AUTH_IDENTITY_REPOSITORY: {
      createGitHubSession: async () => {
        throw new Error("not used");
      },
      findSessionByHash: async () => createIdentitySessionRecord(),
      findLatestGitHubSessionByUserId: async () =>
        createIdentitySessionRecord(),
      revokeSession: async () => undefined,
    },
    AUTH_TRANSCRIPT_REPOSITORY: transcriptRepository,
    AUTH_RUN_REPOSITORY: {
      getRun: async () => ({ sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID }),
    } as unknown as Env["AUTH_RUN_REPOSITORY"],
    AUTH_TURN_ADMISSION_REPOSITORY: {
      reserve: async () => admission,
      getBySessionAndRunId: async () => admission,
    } as unknown as Env["AUTH_TURN_ADMISSION_REPOSITORY"],
    SECURE_API: {} as Env["SECURE_API"],
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    GITHUB_REDIRECT_URI: "x",
    GITHUB_TOKEN_ENCRYPTION_KEY: "x",
    SESSION_SECRET: "x",
    FRONTEND_URL: "x",
    RUN_ENGINE_RUNTIME: runEngineRuntime,
  } as Env;
}

function createIdentitySessionRecord() {
  return {
    authSessionId: "session-1",
    userId: TEST_USER_ID,
    login: "user",
    avatar: "",
    email: "user@example.com",
    name: "User",
    githubScopes: ["repo"],
    encryptedToken: { ciphertext: "ciphertext", iv: "iv", tag: "tag" },
    createdAt: Date.now(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    workspaceId: TEST_WORKSPACE_ID,
    defaultWorkspaceId: TEST_WORKSPACE_ID,
    workspaceIds: [TEST_WORKSPACE_ID],
  };
}
