import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryEventStore,
  MemoryLifecycleEventStore,
  MemoryRunRepository,
  MemoryThreadTitleRepository,
  MemoryTranscriptRepository,
  parseNativeProviderBindingForAdmission,
  NativeProviderBindingSchema,
  type TurnAdmissionRecord,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { HandleChatRequest } from "../../application/chat/HandleChatRequest";
import { AIService } from "../AIService";
import { PersistenceService } from "../PersistenceService";
import { NativeProviderRequests } from "@legioncode/execution-engine/runtime/llm/NativeProviderRequests";
import { createPostgresProviderConfigService } from "../providers/stores/PostgresStoreFactory";
import type { NativeProviderCredentialContext } from "../providers/NativeProviderCredentialResolver";
import { scheduleClaimedInitialThreadTitle } from "./InitialThreadTitleScheduler";
import { ThreadTitleService } from "./ThreadTitleService";

// Replace credential storage and upstream HTTP only; run the real chat/title/SDK path.
vi.mock("../providers/stores/PostgresStoreFactory", () => ({
  createPostgresProviderConfigService: (_env: Env, owner: string, workspace: string, run: string, context?: NativeProviderCredentialContext) => {
    if (!context || context.scope.userId !== owner || context.scope.workspaceId !== workspace || context.scope.runId !== run)
      throw new Error("Integration provider fixture requires its exact claimed admission");
    const binding = parseNativeProviderBindingForAdmission(context.binding, context.scope);
    const selection = Object.freeze({ providerId: binding.providerId, modelId: binding.modelId });
    const assertSelection = (providerId: string, modelId: string) => {
      if (providerId !== selection.providerId || modelId !== selection.modelId)
        throw new Error("Integration provider fixture received a different admitted selection");
    };
    return {
      getNativeProviderSelection: () => selection,
      assertNativeProviderSelection: assertSelection,
      resolveCredential: async (providerId: string) => {
        assertSelection(providerId, selection.modelId);
        return { apiKey: "test-fixture-key" };
      },
      getApiKey: async (providerId: string) => {
        assertSelection(providerId, selection.modelId);
        return "test-fixture-key";
      },
      getConnectionConfig: async () => undefined,
    };
  },
}));

vi.mock("../persistence/BrainPersistenceRepositoryFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../persistence/BrainPersistenceRepositoryFactory")>();
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

const userId = "550e8400-e29b-41d4-a716-446655440000";
const workspaceId = "550e8400-e29b-41d4-a716-446655440002";
afterEach(() => {
  vi.unstubAllGlobals();
});

function harness() {
  const transcripts = new MemoryTranscriptRepository();
  const runs = new MemoryRunRepository();
  const events = new MemoryEventStore();
  const scopes = new Map<string, { threadId: string; turnId: string; runAttemptId: string; runId: string }>();
  const admissions = new Map<string, TurnAdmissionRecord>();
  const admissionFixture = {
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
      const scope = scopes.get(input.sessionId);
      if (!scope || scope.turnId !== input.turnId || scope.runAttemptId !== input.runAttemptId || scope.runId !== input.runId) {
        throw new Error("Integration admission fixture did not receive the exact reserved identity");
      }
      const session = await transcripts.ensureSession({
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId: scope.threadId,
        taskId: input.taskId,
        title: "Create a dark mode toggle",
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
        threadId: scope.threadId,
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
      const bindingScope = { userId: input.userId, workspaceId: input.workspaceId, sessionId: input.sessionId,
        threadId: scope.threadId, turnId: input.turnId, runAttemptId: input.runAttemptId, runId: input.runId };
      const admission: TurnAdmissionRecord = {
        ...bindingScope, clientMessageId: input.clientMessageId, requestFingerprint: input.requestFingerprint,
        state: "admitted", executionState: "pending", revisionOfTurnId: null, continuationOfTurnId: null,
        originalPromptId: null, continuationTerminalSequence: null, admissionOrder: admissions.size + 1,
        createdAt: "2026-11-14T00:00:00Z", admittedAt: "2026-11-14T00:00:00Z",
        nativeProviderBinding: NativeProviderBindingSchema.parse({
          v: 1, kind: "byok", scope: bindingScope, providerId: input.providerId, modelId: input.modelId,
          credential: { connectionId: "123e4567-e89b-42d3-a456-426614174005", userId: input.userId,
            providerId: input.providerId, ownerGeneration: 1, tokenMaterialVersion: 1 },
        }),
      };
      admissions.set(admission.turnId, admission);
      return { admission,
        promptMessageId: prompt.id,
        run,
      };
    },
    async claimExecution(input: { userId: string; workspaceId: string; sessionId: string; runId: string;
      threadId: string; turnId: string; runAttemptId: string; claimId: string }) {
      const admission = admissions.get(input.turnId);
      if (!admission || !input.claimId || Object.entries(input).some(([key, value]) => key !== "claimId" &&
          admission[key as keyof TurnAdmissionRecord] !== value))
        throw new Error("Integration claim fixture did not receive the exact admitted identity");
      if (admission.executionState !== "pending") throw new Error("Integration title attempt was already claimed");
      const claimed = Object.freeze({ ...admission, executionState: "running" as const });
      admissions.set(input.turnId, claimed);
      return { status: "claimed" as const, admission: claimed };
    },
  };
  const env = {
    AUTH_RUN_REPOSITORY: runs,
    AUTH_LIFECYCLE_EVENT_STORE: new MemoryLifecycleEventStore(),
    AUTH_TRANSCRIPT_REPOSITORY: transcripts,
    AUTH_TURN_ADMISSION_REPOSITORY: admissionFixture,
    AUTH_THREAD_TITLE_REPOSITORY: new MemoryThreadTitleRepository(
      transcripts,
      events,
    ),
  } as Env;
  const pending: Promise<unknown>[] = [];
  const submit = async (suffix: string, structured = false, turn = "first") => {
    const scope = { threadId: `thr_${suffix}`, turnId: `trn_${suffix}_${turn}`,
      runAttemptId: `attempt_${suffix}_${turn}`, runId: `run_${suffix}_${turn}` };
    scopes.set(`session_${suffix}`, scope);
    const request = {
      userId,
      workspaceId,
      sessionId: `session_${suffix}`,
      runId: `run_${suffix}_${turn}`,
      correlationId: "title-integration",
      agentType: "coding",
      providerId: "openai",
      modelId: "gpt-4o",
      providerRuntimeRoute: {
        providerId: "openai",
        modelId: "gpt-4o",
        transport: "openai-responses",
        endpoint: "https://api.openai.com/v1/responses",
      },
      modelCapabilities: {
        supportsStructuredOutputs: structured,
        supportsReasoning: false,
      },
      identity: {
        workspaceId,
        threadId: `thr_${suffix}`,
        turnId: `trn_${suffix}_${turn}`,
        runAttemptId: `attempt_${suffix}_${turn}`,
      },
      prompt: "Create a dark mode toggle",
      messages: [{ id: `client_msg_${suffix}_${turn}`, role: "user", content: "Create a dark mode toggle" }],
    } satisfies Parameters<HandleChatRequest["execute"]>[0];
    // Enter through the already-admitted command contract. The submission-only
    // preview is covered separately; all five cases share this real claim path.
    const admitted = await new PersistenceService(env).admitUserTurn({
      sessionId: request.sessionId, runId: request.runId, userId, workspaceId, taskId: request.sessionId,
      identity: request.identity, message: request.messages[0]!, mode: "build", providerId: request.providerId, modelId: request.modelId,
    });
    const result = await new HandleChatRequest(env).execute({ ...request,
      preAdmitted: { run: admitted.run, promptMessageId: admitted.id } });
    const { admission } = await admissionFixture.claimExecution({
      ...scope, userId, workspaceId, sessionId: request.sessionId, claimId: crypto.randomUUID(),
    });
    const context: NativeProviderCredentialContext = { binding: admission.nativeProviderBinding,
      scope: { userId, workspaceId, sessionId: admission.sessionId, runId: admission.runId,
        threadId: admission.threadId, turnId: admission.turnId, runAttemptId: admission.runAttemptId } };
    const ai = new AIService(env, createPostgresProviderConfigService(env, userId, workspaceId, admission.runId, context));
    const originals = new NativeProviderRequests();
    let scheduled = false;
    await scheduleClaimedInitialThreadTitle(env, {
      admission, identity: request.identity, prompt: request.prompt,
      providerRuntimeRoute: request.providerRuntimeRoute, modelCapabilities: request.modelCapabilities,
      execution: { scope: context.scope, signal: new AbortController().signal, service: {
        generateText: input => originals.track(() => ai.generateText(input)),
        generateStructured: input => originals.track(() => ai.generateStructured(input)),
      } },
      owner: { waitUntil: operation => { scheduled = true; pending.push(operation.finally(() => originals.drain())); } },
    });
    if (!scheduled) await originals.drain();
    return result;
  };
  return { transcripts, events, env, pending, submit };
}

function response(content: string) {
  return Response.json({
    id: "resp_title", object: "response", status: "completed", model: "gpt-4o",
    output: [{ type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: content }] }],
    usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
  });
}

describe("chat title product path", () => {
  it.each([false, true])(
    "persists and replays a title through the real provider adapter (structured=%s)",
    async (structured) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          response(
            structured
              ? '{"title":"Create dark mode toggle"}'
              : "Create dark mode toggle",
          ),
        );
      vi.stubGlobal("fetch", fetch);
      const app = harness();
      await app.submit("titlechat", structured);
      await Promise.all(app.pending);
      const stored = await app.transcripts.listSessions(userId);
      expect(stored.sessions[0]).toMatchObject({
        title: "Create dark mode toggle",
        titleSource: "generated",
        titleStatus: "ready",
        titleVersion: 3,
      });
      const replay = await app.events.replay({
        scope: { scopeType: "thread", scopeId: "thr_titlechat" },
        afterCursor: null,
        limit: 10,
      });
      expect(replay.events.map((event) => event.payload)).toEqual([
        expect.objectContaining({ titleStatus: "pending", source: "preview" }),
        expect.objectContaining({
          titleStatus: "ready",
          source: "generated",
          title: stored.sessions[0]?.title,
        }),
      ]);
      expect(fetch).toHaveBeenCalledOnce();
      await app.submit("titlechat", structured, "second");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("keeps a manual rename while an actual provider response is in flight", async () => {
    let complete: (value: Response) => void = () => undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const app = harness();
    await app.submit("renamechat");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const first = await app.transcripts.listTranscript({
      sessionId: "session_renamechat",
      userId,
      cursor: 0,
      limit: 1,
    });
    await new ThreadTitleService(app.env).rename({
      userId,
      workspaceId,
      sessionId: "session_renamechat",
      threadId: "thr_renamechat",
      runId: "run_renamechat_first",
      firstMessageId: first.messages[0]!.id,
      title: "My chosen title",
    });
    complete(response("Create dark mode toggle"));
    await Promise.all(app.pending);
    expect(
      (await app.transcripts.listSessions(userId)).sessions[0],
    ).toMatchObject({
      title: "My chosen title",
      titleSource: "user",
      titleStatus: "ready",
    });
  });

  it("keeps concurrent chats isolated when their provider responses arrive out of order", async () => {
    const complete: Array<(value: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => complete.push(resolve))),
    );
    const app = harness();
    await app.submit("firstchat");
    await app.submit("secondchat");
    await vi.waitFor(() => expect(complete).toHaveLength(2));
    complete[1]!(response("Add dark mode switch"));
    complete[0]!(response("Create dark mode toggle"));
    await Promise.all(app.pending);
    expect((await app.transcripts.listSessions(userId)).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session_firstchat",
          title: "Create dark mode toggle",
        }),
        expect.objectContaining({
          id: "session_secondchat",
          title: "Add dark mode switch",
        }),
      ]),
    );
  });

  it("settles upstream authentication failure without changing the preview source", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { message: "Unauthorized", type: "authentication_error" } },
          { status: 401 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const app = harness();
    expect((await app.submit("failedchat")).success).toBe(true);
    await Promise.all(app.pending);
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      (await app.transcripts.listSessions(userId)).sessions[0],
    ).toMatchObject({
      title: "Create a dark mode toggle",
      titleSource: "preview",
      titleStatus: "failed",
    });
  });
});
