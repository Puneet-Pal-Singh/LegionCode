import { bindAuthenticatedChatRequest } from "../../controllers/ChatRequestBoundary";
import { createWorkspaceRepository } from "../../test-utils/identityTestHelpers";
import { describe, expect, it, vi } from "vitest";
import { MemoryTranscriptRepository } from "@repo/persistence";
import { RunIdSchema } from "@repo/platform-protocol";
import {
  createAppServerClient,
  createAppServerHttpTransport,
} from "@legioncode/sdk";
import type { AppServerRequest } from "@legioncode/sdk";
import { AppServerController } from "../../controllers/AppServerController";
import type { Env } from "../../types/ai";

const TEST_USER_ID = "user-1";
const TEST_WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174000";
const TEST_RUN_ID = RunIdSchema.parse("run_server1");

describe("TurnController public bootstrap contract", () => {
  it("authenticates the request and returns the runtime-issued four-id scope", async () => {
    const runtime = createMockRuntimeNamespace();
    const env = await createEnv(runtime.namespace);
    const client = createClient(env, {
      Cookie: "legioncode_session=test-session-token",
    });

    await expect(
      client.reserveTurnScope({
        runId: TEST_RUN_ID,
        sessionId: "session-1",
        clientMessageId: "client-message-1",
      }),
    ).resolves.toEqual(runtime.identity);
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

    // A recovered, unbound conversation keeps its reserved workspace even when
    // the mutable selection has already moved to another owned project.
    const legacyEnv = await createEnv(runtime.namespace, { sessionWorkspaceId: null, missingRun: true });
    const legacyClient = createClient(legacyEnv, { Cookie: "legioncode_session=test-session-token" });
    await expect(legacyClient.reserveTurnScope({ runId: TEST_RUN_ID, sessionId: "session-1", clientMessageId: "client-message-1" })).resolves.toEqual(runtime.identity);
    await expect(bindAuthenticatedChatRequest(
      new Request("https://brain.local/chat", { headers: { Cookie: "legioncode_session=test-session-token" } }),
      legacyEnv,
      { sessionId: "session-1", runId: TEST_RUN_ID, clientMessageId: "client-message-1", identity: runtime.identity, messages: [{ role: "user", content: "continue" }] },
      "legacy-scope-regression",
    )).resolves.toMatchObject({ userId: TEST_USER_ID, workspaceId: TEST_WORKSPACE_ID });

  });

  it("rejects an unauthenticated pre-stream request before runtime allocation", async () => {
    const runtime = createMockRuntimeNamespace();
    const client = createClient(await createEnv(runtime.namespace));

    await expect(
      client.reserveTurnScope({
        runId: TEST_RUN_ID,
        sessionId: "session-1",
        clientMessageId: "client-message-1",
      }),
    ).rejects.toMatchObject({ status: 401, code: "AUTH_FAILED" });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("rejects a session owned by another user before runtime forwarding", async () => {
    const runtime = createMockRuntimeNamespace();
    const client = createClient(
      await createEnv(runtime.namespace, { sessionUserId: "another-user" }),
      {
        Cookie: "legioncode_session=test-session-token",
      },
    );

    await expect(
      client.reserveTurnScope({
        runId: TEST_RUN_ID,
        sessionId: "session-1",
        clientMessageId: "client-message-1",
      }),
    ).rejects.toMatchObject({ status: 404, code: "SESSION_NOT_FOUND" });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("rejects an established session workspace mismatch before runtime forwarding", async () => {
    const runtime = createMockRuntimeNamespace();
    const client = createClient(
      await createEnv(runtime.namespace, {
        sessionWorkspaceId: "123e4567-e89b-42d3-a456-426614174099",
      }),
      { Cookie: "legioncode_session=test-session-token" },
    );

    await expect(
      client.reserveTurnScope({
        runId: TEST_RUN_ID,
        sessionId: "session-1",
        clientMessageId: "client-message-1",
      }),
    ).rejects.toMatchObject({ status: 409, code: "TURN_SCOPE_MISMATCH" });
    expect(runtime.fetch).not.toHaveBeenCalled();

    for (const headers of [
      { "X-Workspace-Id": "123e4567-e89b-42d3-a456-426614174088" },
      { "X-User-Id": "another-user" },
    ]) {
      const scopedClient = createClient(await createEnv(runtime.namespace), {
        Cookie: "legioncode_session=test-session-token", ...headers,
      });
      await expect(scopedClient.reserveTurnScope({
        runId: TEST_RUN_ID, sessionId: "session-1", clientMessageId: "client-message-1",
      })).rejects.toMatchObject({ status: 403, code: "AUTH_FAILED" });
    }
    const foreignRunEnv = await createEnv(runtime.namespace);
    foreignRunEnv.AUTH_RUN_REPOSITORY = {
      getRun: async () => ({ userId: "another-user", sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID }),
    } as unknown as Env["AUTH_RUN_REPOSITORY"];
    await expect(createClient(foreignRunEnv, { Cookie: "legioncode_session=test-session-token" }).reserveTurnScope({
      runId: TEST_RUN_ID, sessionId: "session-1", clientMessageId: "client-message-1",
    })).rejects.toMatchObject({ status: 403, code: "AUTH_FAILED" });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("returns the same owned tuple for a healthy running turn without forwarding to a DO", async () => {
    const runtime = createMockRuntimeNamespace();
    const client = createClient(
      await createEnv(runtime.namespace, {
        executionState: "running",
        continuationOfTurnId: "trn_original1",
        originalPromptId: "prompt-root-1",
      }),
      {
        Cookie: "legioncode_session=test-session-token",
      },
    );

    await expect(
      client.getTurnScope({ runId: TEST_RUN_ID, sessionId: "session-1" }),
    ).resolves.toEqual({
      ...runtime.identity,
      continuationOfTurnId: "trn_original1",
      originalPromptId: "prompt-root-1",
    });
    expect(runtime.idFromName).not.toHaveBeenCalled();
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("surfaces an explicit recovery-required admission without runtime forwarding", async () => {
    const runtime = createMockRuntimeNamespace();
    const client = createClient(
      await createEnv(runtime.namespace, {
        executionState: "recovery_required",
      }),
      {
        Cookie: "legioncode_session=test-session-token",
      },
    );

    // Recovery reads expose the owned tuple so Stop can settle orphaned work.
    await expect(
      client.getTurnScope({ runId: TEST_RUN_ID, sessionId: "session-1" }),
    ).resolves.toEqual(runtime.identity);
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
});

function createClient(env: Env, headers: Record<string, string> = {}) {
  return createAppServerClient({
    clientId: "hosted-turn-scope-test",
    clientVersion: "0.1.0",
    transport: createAppServerHttpTransport({
      baseUrl: "https://brain.local",
      credentials: "include",
      timeoutMs: null,
      maxResponseBytes: null,
      requestHeaders: (envelope: AppServerRequest) =>
        envelope.method === "turn/reserve" || envelope.method === "turn/scope"
          ? { "X-Correlation-Id": "turn-scope-test-correlation" }
          : {},
      fetchImpl: async (input, init) => {
        const requestHeaders = new Headers(init?.headers);
        for (const [name, value] of Object.entries(headers))
          requestHeaders.set(name, value);
        return AppServerController.request(
          new Request(input, { ...init, headers: requestHeaders }),
          env,
        );
      },
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
    sessionWorkspaceId?: string | null;
    missingRun?: boolean;
    executionState?: "pending" | "running" | "recovery_required" | "settled";
    continuationOfTurnId?: string;
    originalPromptId?: string;
  } = {},
): Promise<Env> {
  const transcriptRepository = new MemoryTranscriptRepository();
  await transcriptRepository.ensureSession({
    sessionId: "session-1",
    userId: options.sessionUserId ?? TEST_USER_ID,
    workspaceId: "sessionWorkspaceId" in options ? options.sessionWorkspaceId : TEST_WORKSPACE_ID,
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
    continuationOfTurnId: options.continuationOfTurnId ?? null,
    originalPromptId: options.originalPromptId ?? null,
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
    AUTH_WORKSPACE_REPOSITORY: createWorkspaceRepository(TEST_USER_ID, TEST_WORKSPACE_ID, "123e4567-e89b-42d3-a456-426614174088"),
    AUTH_RUN_REPOSITORY: {
      getRun: async () => options.missingRun ? null : ({
        sessionId: "session-1",
        userId: TEST_USER_ID,
        workspaceId: TEST_WORKSPACE_ID,
      }),
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
    workspaceId: "123e4567-e89b-42d3-a456-426614174088",
    defaultWorkspaceId: "123e4567-e89b-42d3-a456-426614174088",
    workspaceIds: ["123e4567-e89b-42d3-a456-426614174088"],
  };
}
