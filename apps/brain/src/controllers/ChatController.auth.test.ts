import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryEventStore,
  MemoryRunRepository,
  MemoryThreadTitleRepository,
  MemoryTranscriptRepository,
} from "@repo/persistence";
import { ChatController } from "./ChatController";
import type { Env } from "../types/ai";

vi.mock("../services/persistence/BrainPersistenceRepositoryFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/persistence/BrainPersistenceRepositoryFactory")>();
  return {
    ...actual,
    withBrainPersistenceRepository: async (env, override, createRepository, callback) => {
      const admissionFixture = env.AUTH_TURN_ADMISSION_REPOSITORY;
      const repositoryProbe = override ?? createRepository({} as never);
      if (admissionFixture && typeof repositoryProbe.admitWithPrompt === "function") {
        return callback(admissionFixture);
      }
      return actual.withBrainPersistenceRepository(env, override, createRepository, callback);
    },
  };
});

const VALID_RUN_ID = "run_123e4567e89b42d3a456426614174000";
const TEST_USER_ID = "user-123";
const TEST_WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174000";
const TEST_SESSION_TOKEN = "test-session-token";

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
          Cookie: `legioncode_session=${TEST_SESSION_TOKEN}`,
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

  it("rejects client-owned context and pricing metadata", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);

    const response = await ChatController.handle(
      createChatRequest({
        headers: {
          Cookie: `legioncode_session=${TEST_SESSION_TOKEN}`,
        },
        body: {
          providerId: "openai",
          modelId: "gpt-5",
          contextWindowTokens: 1,
          pricing: { inputPer1M: 0, outputPer1M: 0 },
        },
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("accepts the AI SDK transport id without using it as lifecycle identity", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = createEnv(runtime.namespace);

    const response = await ChatController.handle(
      createChatRequest({
        headers: {
          Cookie: `legioncode_session=${TEST_SESSION_TOKEN}`,
        },
        body: { id: "web-chat-instance" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const fetchCall = runtime.fetch.mock.calls[0];
    expect(fetchCall).toBeDefined();
    const payload = JSON.parse((fetchCall?.[1] as { body: string }).body) as {
      identity?: {
        threadId?: string;
        turnId?: string;
        runAttemptId?: string;
      };
    };
    expect(payload.identity).toMatchObject({
      threadId: "thr_test001",
      turnId: "trn_test001",
      runAttemptId: "attempt_test001",
    });
  });
});

function createChatRequest(options?: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
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
      identity: {
        workspaceId: TEST_WORKSPACE_ID,
        threadId: "thr_test001",
        turnId: "trn_test001",
        runAttemptId: "attempt_test001",
      },
      messages: [
        {
          role: "user",
          content: "hello",
        },
      ],
      clientMessageId: "client_msg_auth_default",
      ...options?.body,
    }),
  });
}

function createAdmissionFixture(
  transcripts: MemoryTranscriptRepository,
  runs: MemoryRunRepository,
) {
  return {
    async admitWithPrompt(input: {
      sessionId: string;
      clientMessageId: string;
      turnId: string;
      runAttemptId: string;
      runId: string;
      requestFingerprint: string;
      userId: string;
      workspaceId: string;
      taskId: string;
      mode: string;
      providerId?: string | null;
      modelId?: string | null;
      branch?: string | null;
      runStatus?: "created" | "running" | "paused" | "completed" | "failed" | "cancelled";
      promptMessage: {
        role: "user";
        clientMessageId: string;
        dedupeKey: string;
        parts: Array<{ type: "text" | "tool_call" | "tool_result" | "activity" | "compaction_summary" | "raw"; content: any }>;
      };
    }) {
      const promptContent = input.promptMessage.parts[0]?.content as {
        metadata?: { canonicalIdentity?: { threadId?: string } };
      } | undefined;
      const threadId = promptContent?.metadata?.canonicalIdentity?.threadId ?? "thr_test001";
      const session = await transcripts.ensureSession({
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId,
        taskId: input.taskId,
        title: null,
        activeRunId: input.runId,
        mode: input.mode,
        status: "running",
      });
      const run = await runs.ensureRun({
        id: input.runId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        status: input.runStatus ?? "running",
        mode: input.mode,
        providerId: input.providerId,
        modelId: input.modelId,
        branch: input.branch,
      });
      const prompt = await transcripts.appendMessage({
        sessionId: session.id,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId,
        taskId: input.taskId,
        activeRunId: input.runId,
        mode: input.mode,
        status: "running",
        runId: input.runId,
        role: "user",
        clientMessageId: input.promptMessage.clientMessageId,
        dedupeKey: input.promptMessage.dedupeKey,
        parts: input.promptMessage.parts,
      });
      return {
        admission: {
          sessionId: input.sessionId,
          clientMessageId: input.clientMessageId,
          turnId: input.turnId,
          runAttemptId: input.runAttemptId,
          runId: input.runId,
          requestFingerprint: input.requestFingerprint,
          state: "admitted",
        },
        promptMessageId: prompt.id,
        run,
      };
    },
  } as unknown as NonNullable<Env["AUTH_TURN_ADMISSION_REPOSITORY"]>;
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
  const transcripts = new MemoryTranscriptRepository();
  const runs = new MemoryRunRepository();
  const events = new MemoryEventStore();

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
    AUTH_TRANSCRIPT_REPOSITORY: transcripts,
    AUTH_RUN_REPOSITORY: runs,
    AUTH_TURN_ADMISSION_REPOSITORY: createAdmissionFixture(transcripts, runs),
    AUTH_THREAD_TITLE_REPOSITORY: new MemoryThreadTitleRepository(
      transcripts,
      events,
    ),
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
