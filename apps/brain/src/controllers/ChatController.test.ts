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
const mockCloudflareAgentExecute = vi.fn();

vi.mock("@shadowbox/orchestrator-adapters-cloudflare-agents", () => ({
  CloudflareAgent: class MockCloudflareAgent {},
  CloudflareAgentsRunRuntimeClient: class MockRuntimeClient {
    execute = mockCloudflareAgentExecute;
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

describe("ChatController DO runtime migration", () => {
  beforeEach(() => {
    mockCloudflareAgentExecute.mockReset();
    mockCloudflareAgentExecute.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Shadowbox-Runtime-Name": "brain-run-engine-do",
          "X-Shadowbox-Runtime-Git-Sha": "run-engine-sha",
          "X-Shadowbox-Runtime-Started-At": "2026-03-23T00:00:00.000Z",
          "X-Shadowbox-Runtime-Boot-Id": "run-engine-boot",
          "X-Shadowbox-Runtime-Fingerprint":
            "brain-run-engine-do:run-engine-sha:run-engine-boot",
        },
      }),
    );
  });

  it("routes execution through RUN_ENGINE_RUNTIME and tags response headers", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);

    const response = await ChatController.handle(
      await createChatRequest(env),
      env,
    );

    expect(response.status).toBe(200);
    expect(runtime.idFromName).toHaveBeenCalledWith(VALID_RUN_ID);
    expect(runtime.get).toHaveBeenCalledTimes(1);
    expect(runtime.fetch).toHaveBeenCalledTimes(1);
    expect(response.headers.get("X-Run-Engine-Runtime")).toBe("do");
    expect(response.headers.get("X-Shadowbox-Runtime-Name")).toBe(
      "brain-worker",
    );
    expect(response.headers.get("X-Shadowbox-Runtime-Fingerprint")).toContain(
      "brain-worker:",
    );
    expect(response.headers.get("X-Shadowbox-Run-Engine-Name")).toBe(
      "brain-run-engine-do",
    );
    expect(response.headers.get("X-Shadowbox-Run-Engine-Fingerprint")).toBe(
      "brain-run-engine-do:run-engine-sha:run-engine-boot",
    );
  });

  it("fails fast when RUN_ENGINE_RUNTIME binding is unavailable", async () => {
    const envWithRuntime = createEnv(createMockRuntimeNamespace().namespace);
    const envWithoutRuntime = envWithRuntime as unknown as Record<
      string,
      unknown
    >;
    delete envWithoutRuntime.RUN_ENGINE_RUNTIME;

    const response = await ChatController.handle(
      await createChatRequest(envWithRuntime),
      envWithoutRuntime as unknown as Env,
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("RUN_ENGINE_RUNTIME binding is unavailable");
  });

  it("forwards provider/model override fields to runtime payload", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);
    const requestWithProviderModel = await createChatRequest(env, {
      providerId: "openai",
      modelId: "gpt-4",
    });

    const response = await ChatController.handle(requestWithProviderModel, env);

    expect(response.status).toBe(200);
    const fetchCall = runtime.fetch.mock.calls[0];
    expect(fetchCall).toBeDefined();

    // Verify the payload sent to runtime includes provider/model
    const payloadStr = (fetchCall[1] as { body: string }).body;
    const payload = JSON.parse(payloadStr);
    expect(payload.input.providerId).toBe("openai");
    expect(payload.input.modelId).toBe("gpt-4");
  });

  it("forwards deterministic runtime selection defaults to payload", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);

    const response = await ChatController.handle(
      await createChatRequest(env),
      env,
    );

    expect(response.status).toBe(200);
    const fetchCall = runtime.fetch.mock.calls[0];
    expect(fetchCall).toBeDefined();

    const payloadStr = (fetchCall[1] as { body: string }).body;
    const payload = JSON.parse(payloadStr) as {
      input: {
        mode: string;
        orchestratorBackend: string;
        executionBackend: string;
        harnessMode: string;
        authMode: string;
      };
    };

    expect(payload.input.mode).toBe("build");
    expect(payload.input.orchestratorBackend).toBe("execution-engine-v1");
    expect(payload.input.executionBackend).toBe("cloudflare_sandbox");
    expect(payload.input.harnessMode).toBe("platform_owned");
    expect(payload.input.authMode).toBe("api_key");
  });

  it("fails fast when cloudflare_agents is requested without the feature flag", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);
    const requestWithOverrides = await createChatRequest(env, {
      orchestratorBackend: "cloudflare_agents",
      executionBackend: "e2b",
      harnessMode: "delegated",
      authMode: "oauth",
    });

    const response = await ChatController.handle(requestWithOverrides, env);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("CLOUDFLARE_AGENTS_BACKEND_DISABLED");
    expect(body.error).toContain("cloudflare_agents backend is not enabled");
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("routes cloudflare_agents requests through the SDK-backed agent binding", async () => {
    const runtime = createMockRuntimeNamespace();
    const agentNamespace = {} as Env["RUN_ENGINE_AGENT"];
    const env = createEnv(runtime.namespace, {
      runEngineAgent: agentNamespace,
      cloudflareAgentsEnabled: "true",
    });
    const requestWithOverrides = await createChatRequest(env, {
      mode: "plan",
      orchestratorBackend: "cloudflare_agents",
      executionBackend: "e2b",
      harnessMode: "delegated",
      authMode: "oauth",
    });

    const response = await ChatController.handle(requestWithOverrides, env);

    expect(response.status).toBe(200);
    expect(runtime.fetch).not.toHaveBeenCalled();
    expect(mockCloudflareAgentExecute).toHaveBeenCalledTimes(1);
    const payload = mockCloudflareAgentExecute.mock.calls[0]?.[0] as {
      runId: string;
      payload: {
        input: {
          mode: string;
          orchestratorBackend: string;
          executionBackend: string;
          harnessMode: string;
          authMode: string;
        };
      };
    };

    expect(agentNamespace).toBeDefined();
    expect(payload.runId).toBe(VALID_RUN_ID);
    expect(payload.payload.input.mode).toBe("plan");
    expect(payload.payload.input.orchestratorBackend).toBe("cloudflare_agents");
    expect(payload.payload.input.executionBackend).toBe("e2b");
    expect(payload.payload.input.harnessMode).toBe("delegated");
    expect(payload.payload.input.authMode).toBe("oauth");
    expect(response.headers.get("X-Run-Engine-Runtime")).toBe(
      "cloudflare_agents",
    );
  });

  it("forwards repository context fields to runtime payload", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);
    const requestWithRepoContext = await createChatRequest(env, {
      repositoryOwner: "sourcegraph",
      repositoryName: "shadowbox",
      repositoryBranch: "dev",
      repositoryBaseUrl: "https://github.com/sourcegraph/shadowbox",
      messages: [
        {
          role: "user",
          content: "check README.md",
        },
      ],
    });

    const response = await ChatController.handle(requestWithRepoContext, env);

    expect(response.status).toBe(200);
    const fetchCall = runtime.fetch.mock.calls[0];
    expect(fetchCall).toBeDefined();

    const payloadStr = (fetchCall[1] as { body: string }).body;
    const payload = JSON.parse(payloadStr) as {
      input: {
        repositoryContext?: {
          owner?: string;
          repo?: string;
          branch?: string;
          baseUrl?: string;
        };
      };
    };
    expect(payload.input.repositoryContext).toEqual({
      owner: "sourcegraph",
      repo: "shadowbox",
      branch: "dev",
      baseUrl: "https://github.com/sourcegraph/shadowbox",
    });
  });

  it("extracts prompt text from structured user message content parts", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);
    const request = await createChatRequest(env, {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "so? what is your name?" }],
        },
      ],
    });

    const response = await ChatController.handle(request, env);

    expect(response.status).toBe(200);
    const fetchCall = runtime.fetch.mock.calls[0];
    expect(fetchCall).toBeDefined();

    const payloadStr = (fetchCall[1] as { body: string }).body;
    const payload = JSON.parse(payloadStr) as { input: { prompt: string } };
    expect(payload.input.prompt).toBe("so? what is your name?");
  });

  it("returns validation error for unsupported agentId", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);
    const response = await ChatController.handle(
      await createChatRequest(env, { agentId: "unknown-agent" }),
      env,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("INVALID_AGENT_TYPE");
    expect(body.error).toContain("Unsupported agentId");
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("returns validation error when runId is missing", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);
    const response = await ChatController.handle(
      await createChatRequest(env, { runId: undefined }),
      env,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("MISSING_FIELD");
    expect(body.error).toContain("runId");
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("returns validation error when messages array is empty", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);
    const request = new Request("https://brain.local/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        runId: VALID_RUN_ID,
        messages: [],
      }),
    });

    const response = await ChatController.handle(request, env);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("INVALID_MESSAGES");
    expect(body.error).toContain("expected non-empty array");
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("returns typed deprecation error for legacy /api/chat route", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);
    const response = await ChatController.handleLegacyRoute(
      new Request("https://brain.local/api/chat", {
        method: "POST",
      }),
      env,
    );

    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("LEGACY_CHAT_ROUTE_REMOVED");
    expect(body.error).toContain("/api/chat");
  });

  it("derives authenticated user/workspace scope for runtime payload", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);
    const token = await createSessionToken(TEST_USER_ID, env.SESSION_SECRET);
    const request = new Request("https://brain.local/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `shadowbox_session=${token}`,
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

    const response = await ChatController.handle(request, env);

    expect(response.status).toBe(200);
    const fetchCall = runtime.fetch.mock.calls[0];
    expect(fetchCall).toBeDefined();

    const payloadStr = (fetchCall[1] as { body: string }).body;
    const payload = JSON.parse(payloadStr) as {
      userId?: string;
      workspaceId?: string;
    };
    expect(payload.userId).toBe(TEST_USER_ID);
    expect(payload.workspaceId).toBe(TEST_WORKSPACE_ID);
  });
});

async function createChatRequest(
  env: Env,
  overrides: {
    runId?: string;
    agentId?: string;
    mode?: "build" | "plan";
    providerId?: string;
    modelId?: string;
    orchestratorBackend?: "execution-engine-v1" | "cloudflare_agents";
    executionBackend?: "cloudflare_sandbox" | "e2b" | "daytona";
    harnessMode?: "platform_owned" | "delegated";
    authMode?: "api_key" | "oauth";
    repositoryOwner?: string;
    repositoryName?: string;
    repositoryBranch?: string;
    repositoryBaseUrl?: string;
    messages?: Array<{
      role: string;
      content: unknown;
    }>;
  } = {},
): Promise<Request> {
  const runIdValue = "runId" in overrides ? overrides.runId : VALID_RUN_ID;
  const token = await createSessionToken(TEST_USER_ID, env.SESSION_SECRET);

  return new Request("https://brain.local/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `shadowbox_session=${token}`,
    },
    body: JSON.stringify({
      sessionId: "session-1",
      runId: runIdValue,
      agentId: overrides.agentId,
      mode: overrides.mode,
      providerId: overrides.providerId,
      modelId: overrides.modelId,
      orchestratorBackend: overrides.orchestratorBackend,
      executionBackend: overrides.executionBackend,
      harnessMode: overrides.harnessMode,
      authMode: overrides.authMode,
      repositoryOwner: overrides.repositoryOwner,
      repositoryName: overrides.repositoryName,
      repositoryBranch: overrides.repositoryBranch,
      repositoryBaseUrl: overrides.repositoryBaseUrl,
      messages: overrides.messages ?? [
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
      headers: {
        "Content-Type": "application/json",
        "X-Shadowbox-Runtime-Name": "brain-run-engine-do",
        "X-Shadowbox-Runtime-Git-Sha": "run-engine-sha",
        "X-Shadowbox-Runtime-Started-At": "2026-03-23T00:00:00.000Z",
        "X-Shadowbox-Runtime-Boot-Id": "run-engine-boot",
        "X-Shadowbox-Runtime-Fingerprint":
          "brain-run-engine-do:run-engine-sha:run-engine-boot",
      },
    });
  });
  const get = vi.fn(() => ({ fetch }));
  const idFromName = vi.fn(() => ({ toString: () => "mock-do-id" }));

  const namespace = {
    idFromName,
    get,
  } as unknown as Env["RUN_ENGINE_RUNTIME"];

  return { namespace, idFromName, get, fetch };
}

function createEnv(
  runEngineRuntime: Env["RUN_ENGINE_RUNTIME"],
  options: {
    runEngineAgent?: Env["RUN_ENGINE_AGENT"];
    cloudflareAgentsEnabled?: Env["FEATURE_FLAG_CLOUDFLARE_AGENTS_V1"];
  } = {},
): Env {
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
    RUN_ENGINE_AGENT: options.runEngineAgent,
    FEATURE_FLAG_CLOUDFLARE_AGENTS_V1:
      options.cloudflareAgentsEnabled ?? "false",
  };
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

async function createSessionToken(
  userId: string,
  secret: string,
): Promise<string> {
  const timestamp = Date.now().toString();
  const data = `${userId}:${timestamp}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(data),
  );
  const signature = btoa(
    String.fromCharCode(...new Uint8Array(signatureBuffer)),
  );
  return `${data}:${signature}`;
}
