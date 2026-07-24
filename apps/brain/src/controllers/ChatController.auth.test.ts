import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRunRepository,
  MemoryTranscriptRepository,
} from "@repo/persistence";
import { ChatController } from "./ChatController";
import type { Env } from "../types/ai";

const VALID_RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const TEST_USER_ID = "user-123";
const TEST_WORKSPACE_ID = "default";
const TEST_SESSION_TOKEN = "test-session-token";

vi.mock("@shadowbox/orchestrator-adapters-cloudflare-agents", () => ({
  CloudflareAgent: class MockCloudflareAgent {},
  CloudflareAgentsRunRuntimeClient: class MockRuntimeClient {
    execute = vi.fn();
    getSummary = vi.fn();
    cancel = vi.fn();
  },
  parseCloudflareAgentsFeatureFlag: (value: string | undefined) =>
    value === "true" || value === "1",
  shouldActivateCloudflareAgentsAdapter: ({
    requestedBackend,
    featureFlagEnabled,
  }: {
    requestedBackend: string;
    featureFlagEnabled: boolean;
  }) => featureFlagEnabled && requestedBackend === "cloudflare_agents",
}));

describe("ChatController auth contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns typed AUTH_FAILED when chat request has no auth token", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);

    const response = await ChatController.handle(createChatRequest(), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "AUTH_FAILED",
      error: "Unauthorized: missing authentication token.",
    });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("accepts authenticated chat requests and forwards resolved scope", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);

    const response = await ChatController.handle(
      createChatRequest({
        headers: {
          Cookie: `shadowbox_session=${TEST_SESSION_TOKEN}`,
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const fetchCall = runtime.fetch.mock.calls[0];
    expect(fetchCall).toBeDefined();
    const payload = JSON.parse((fetchCall?.[1] as { body: string }).body) as {
      userId?: string;
      workspaceId?: string;
    };

    expect(payload.userId).toBe(TEST_USER_ID);
    expect(payload.workspaceId).toBe(TEST_WORKSPACE_ID);
  });
});

function createChatRequest(options?: {
  headers?: Record<string, string>;
}): Request {
  return new Request("https://brain.local/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    body: JSON.stringify({
      sessionId: "session-1",
      runId: VALID_RUN_ID,
      messages: [
        {
          role: "user",
          content: "hello",
        },
      ],
    }),
  });
}

function createMockRuntimeNamespace() {
  const fetch = vi.fn(async () => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const get = vi.fn(() => ({ fetch }));
  const idFromName = vi.fn(() => ({ toString: () => "mock-do-id" }));

  const namespace = {
    idFromName,
    get,
  } as unknown as Env["RUN_ENGINE_RUNTIME"];

  return { namespace, fetch };
}

function createEnv(runEngineRuntime: Env["RUN_ENGINE_RUNTIME"]): Env {
  const oauthState = new Map<string, string>();

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
    SECURE_API: {
      fetch: vi.fn(async () => new Response(JSON.stringify({ success: true }))),
    } as unknown as Env["SECURE_API"],
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    GITHUB_REDIRECT_URI: "x",
    GITHUB_TOKEN_ENCRYPTION_KEY: "x",
    SESSION_SECRET: "x",
    FRONTEND_URL: "x",
    SESSIONS: {
      get: async (key: string) => oauthState.get(key) ?? null,
      put: async (key: string, value: string) => {
        oauthState.set(key, value);
      },
      delete: async (key: string) => {
        oauthState.delete(key);
      },
    } as unknown as Env["SESSIONS"],
    RUN_ENGINE_RUNTIME: runEngineRuntime,
    RUN_ADMISSION_LIMITER: createMockRunAdmissionLimiterNamespace(),
    FEATURE_FLAG_CLOUDFLARE_AGENTS_V1: "false",
  } as Env;
}

function createIdentitySessionRecord() {
  return {
    authSessionId: "session-1",
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

function createMockRunAdmissionLimiterNamespace(): Env["RUN_ADMISSION_LIMITER"] {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      input instanceof URL
        ? input
        : typeof input === "string"
          ? new URL(input)
          : new URL(input.url);
    if (url.pathname === "/release-concurrency") {
      return new Response(JSON.stringify({ released: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        allowed: true,
        retryAfterSeconds: 0,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
  const get = vi.fn(() => ({ fetch }));
  const idFromName = vi.fn(() => ({ toString: () => "mock-admission-id" }));

  return {
    idFromName,
    get,
  } as unknown as Env["RUN_ADMISSION_LIMITER"];
}
