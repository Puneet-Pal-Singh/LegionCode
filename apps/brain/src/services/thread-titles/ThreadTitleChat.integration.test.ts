import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryEventStore,
  MemoryLifecycleEventStore,
  MemoryRunRepository,
  MemoryThreadTitleRepository,
  MemoryTranscriptRepository,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { HandleChatRequest } from "../../application/chat/HandleChatRequest";
import { ThreadTitleService } from "./ThreadTitleService";

// Replace credential storage and upstream HTTP only; run the real chat/title/SDK path.
vi.mock("../providers/stores/PostgresStoreFactory", () => ({
  createPostgresProviderConfigService: () => ({
    getApiKey: async () => "test-fixture-key",
    getConnectionConfig: async () => undefined,
  }),
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
  };
  const env = {
    OPENAI_API_KEY: "test-fixture-key",
    AUTH_RUN_REPOSITORY: new MemoryRunRepository(),
    AUTH_LIFECYCLE_EVENT_STORE: new MemoryLifecycleEventStore(),
    AUTH_TRANSCRIPT_REPOSITORY: transcripts,
    AUTH_TURN_ADMISSION_REPOSITORY: admissionFixture,
    AUTH_THREAD_TITLE_REPOSITORY: new MemoryThreadTitleRepository(
      transcripts,
      events,
    ),
  } as Env;
  const pending: Promise<unknown>[] = [];
  const submit = (suffix: string, structured = false, turn = "first") =>
    (scopes.set(`session_${suffix}`, {
      threadId: `thr_${suffix}`,
      turnId: `trn_${suffix}_${turn}`,
      runAttemptId: `attempt_${suffix}_${turn}`,
      runId: `run_${suffix}_${turn}`,
    }), new HandleChatRequest(env).execute({
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
        transport: "openai-chat-completions",
        endpoint: "https://api.openai.com/v1/chat/completions",
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
      backgroundTaskOwner: { waitUntil: (promise) => pending.push(promise) },
    }));
  return { transcripts, events, env, pending, submit };
}

function response(content: string) {
  return Response.json({
    id: "chatcmpl_title",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
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
