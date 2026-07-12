import { describe, expect, it, vi } from "vitest";
import {
  MemoryRunRepository,
  MemoryTranscriptRepository,
} from "@repo/persistence";
import { TurnController } from "./TurnController";
import type { Env } from "../types/ai";

const TEST_USER_ID = "user-1";
const TEST_WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174000";
const TEST_RUN_ID = "run_server1";

vi.mock("@shadowbox/orchestrator-adapters-cloudflare-agents", () => ({
  CloudflareAgentsRunRuntimeClient: class MockRuntimeClient {},
  parseCloudflareAgentsFeatureFlag: () => false,
  shouldActivateCloudflareAgentsAdapter: () => false,
}));

describe("TurnController public bootstrap contract", () => {
  it("authenticates the request and returns the runtime-issued four-id scope", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);

    const response = await TurnController.start(
      createTurnStartRequest({ Cookie: "shadowbox_session=test-session-token" }),
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
    body: JSON.stringify({ sessionId: "session-1", runId: TEST_RUN_ID }),
  });
}

function createMockRuntimeNamespace() {
  const identity = {
    workspaceId: TEST_WORKSPACE_ID,
    threadId: "thr_server1",
    turnId: "trn_server1",
    runAttemptId: "attempt_server1",
  };
  const fetch = vi.fn(async () =>
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

function createEnv(runEngineRuntime: Env["RUN_ENGINE_RUNTIME"]): Env {
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
    AUTH_TRANSCRIPT_REPOSITORY: new MemoryTranscriptRepository(),
    AUTH_RUN_REPOSITORY: new MemoryRunRepository(),
    SECURE_API: {} as Env["SECURE_API"],
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    GITHUB_REDIRECT_URI: "x",
    GITHUB_TOKEN_ENCRYPTION_KEY: "x",
    SESSION_SECRET: "x",
    FRONTEND_URL: "x",
    RUN_ENGINE_RUNTIME: runEngineRuntime,
    FEATURE_FLAG_CLOUDFLARE_AGENTS_V1: "false",
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
