import {
  PNG_DATA_URL,
  PNG_BYTES,
} from "../../services/chat/__tests__/ImageFixtures";
import { PhotonImage } from "@cf-wasm/photon";
import { imageSize } from "image-size";
import type { CoreMessage } from "ai";
import type { R2Bucket } from "@cloudflare/workers-types";
import {
  MemoryTranscriptRepository,
  MemoryRunRepository,
  type RunRepository,
  type TranscriptRepository,
} from "@repo/persistence";
import { MemoryLifecycleEventStore } from "@repo/persistence";
import { TurnIdSchema, type TurnScopeBootstrap } from "@repo/platform-protocol";
import {
  CodingAgent,
  type RuntimeStorage,
} from "@legioncode/execution-engine/runtime";
import { RuntimeKernelNativeRunner } from "@legioncode/execution-engine/runtime";
import type { ILLMGateway } from "@legioncode/execution-engine/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import { HandleChatRequest } from "./HandleChatRequest";
import { PersistenceService } from "../../services/PersistenceService";
import { BrainLifecycleEventStore } from "../../services/lifecycle/BrainLifecycleEventStore";
import { ThreadTitleService } from "../../services/thread-titles";
import { readTranscriptImageAttachments } from "../../services/chat/TranscriptImageAttachments";

const { withTranscriptRepositoryMock, withRunRepositoryMock } = vi.hoisted(
  () => ({
    withTranscriptRepositoryMock: vi.fn(),
    withRunRepositoryMock: vi.fn(),
  }),
);
vi.mock("../../services/runs/RunPersistenceFactory", () => ({
  withRunRepository: withRunRepositoryMock,
}));
vi.mock("../../services/sessions/TranscriptPersistenceFactory", () => ({
  withTranscriptRepository: withTranscriptRepositoryMock,
}));
vi.mock("../../services/persistence/BrainPersistenceRepositoryFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/persistence/BrainPersistenceRepositoryFactory")>();
  return {
    ...actual,
    withBrainPersistenceRepository: async (env, override, createRepository, callback) => {
      const fixture = env.AUTH_TURN_ADMISSION_REPOSITORY;
      const repositoryProbe = override ?? createRepository({} as never);
      if (fixture && typeof repositoryProbe.admitWithPrompt === "function") {
        return callback(fixture);
      }
      return actual.withBrainPersistenceRepository(env, override, createRepository, callback);
    },
  };
});

const sessionId = "123e4567-e89b-42d3-a456-426614174001";
const userId = "123e4567-e89b-42d3-a456-426614174002";
const runId = "run_123e4567e89b42d3a456426614174000";
const identity: TurnScopeBootstrap = {
  workspaceId: "123e4567-e89b-42d3-a456-426614174003",
  threadId: "thr_image_delivery01",
  turnId: "trn_image_delivery01",
  runAttemptId: "attempt_image_delivery01",
};
const image = {
  type: "image" as const,
  image: PNG_DATA_URL,
  mimeType: "image/png",
};
const imageMessage: CoreMessage = {
  role: "user",
  content: [{ type: "text", text: "Inspect the agents screenshot" }, image],
};

describe("authenticated image submission through native provider delivery", () => {
  let repository: MemoryTranscriptRepository;
  let bucket: MemoryMediaBucket;
  let env: Env;
  let admissionFixture: NonNullable<Env["AUTH_TURN_ADMISSION_REPOSITORY"]>;
  beforeEach(() => {
    repository = new MemoryTranscriptRepository();
    const runs = new MemoryRunRepository();
    withRunRepositoryMock.mockImplementation(
      async (_env: Env, callback: (repo: RunRepository) => Promise<unknown>) =>
        callback(runs),
    );
    bucket = new MemoryMediaBucket();
    admissionFixture = createAdmissionFixture(repository, runs);
    vi.spyOn(admissionFixture, "admitWithPrompt");
    env = {
      EDIT_ARTIFACTS: bucket as unknown as R2Bucket,
      AUTH_TURN_ADMISSION_REPOSITORY: admissionFixture,
    } as Env;
    withTranscriptRepositoryMock.mockImplementation(
      async (
        _env: Env,
        callback: (repo: TranscriptRepository) => Promise<unknown>,
      ) => callback(repository),
    );
    vi.spyOn(BrainLifecycleEventStore.prototype, "replay").mockResolvedValue({
      events: [],
      nextSequence: null,
    });
    vi.spyOn(ThreadTitleService.prototype, "persistPreview").mockResolvedValue(
      null,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("delivers stored pixels on submission, later recall, and text-only revision after reload", async () => {
    const first = await submit(env, imageMessage, identity);
    await expectProviderImage(first.executionPayload);
    const transcript = await repository.listTranscript({
      userId,
      sessionId,
      cursor: 0,
      limit: 100,
    });
    const refs = readTranscriptImageAttachments(transcript.messages[0]!);
    expect(refs).toHaveLength(1);
    expect(JSON.stringify(transcript)).not.toContain("base64");

    const recallIdentity = {
      ...identity,
      turnId: "trn_image_recall01",
      runAttemptId: "attempt_image_recall01",
    };
    // A fresh request contains only the current text, as after browser reload.
    const recalled = await submit(
      env,
      { role: "user", content: "What was in the previous screenshot?" },
      recallIdentity,
    );
    await expectProviderImage(recalled.executionPayload);

    const revisionIdentity = {
      ...identity,
      turnId: "trn_image_revision01",
      runAttemptId: "attempt_image_revision01",
      revisionOfTurnId: identity.turnId,
    };
    const revised = await submit(
      env,
      { role: "user", content: "Focus on the agents page" },
      revisionIdentity,
    );
    await expectProviderImage(revised.executionPayload);
    expect(JSON.stringify(revised.executionPayload.messages)).not.toContain(
      "Inspect the agents screenshot",
    );
    const saved = await repository.listTranscript({
      userId,
      sessionId,
      cursor: 0,
      limit: 100,
    });
    expect(readTranscriptImageAttachments(saved.messages.at(-1)!)).toEqual(
      refs,
    );
    expect(admissionFixture.admitWithPrompt).toHaveBeenCalledTimes(3);
    expect(admissionFixture.admitWithPrompt.mock.calls[0]?.[0]).toMatchObject({
      turnId: identity.turnId,
      clientMessageId: `client_${identity.turnId}`,
    });
    expect(admissionFixture.admitWithPrompt.mock.calls[2]?.[0]).toMatchObject({
      turnId: revisionIdentity.turnId,
      clientMessageId: `client_${revisionIdentity.turnId}`,
    });
    expect(bucket.objects.size).toBe(1);
  });

  it("keeps images and newly completed tool pairs through automatic and manual compaction and terminal replay", async () => {
    await new PersistenceService(env).persistUserMessage(
      sessionId,
      runId,
      {
        role: "user",
        content: "Preserve previous instructions. " + "history ".repeat(3_000),
      },
      { userId, identity: { ...identity, turnId: "trn_image_history01" } },
    );
    const submission = await submit(env, imageMessage, identity, 2_000);
    const { requests, lifecycle, execute } = createRuntime(
      submission.executionPayload,
      true,
    );
    await execute();
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(providerImages(request)).toContainEqual(image);
      expect(
        request.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.startsWith("Compacted conversation context:"),
        ),
      ).toBe(true);
    }
    expect(JSON.stringify(requests[1])).toContain("completed tool 1");
    expect(JSON.stringify(requests[2])).toContain("completed tool 2");
    expect(
      requests[2]!.filter((message) => message.role === "tool"),
    ).toHaveLength(2);
    const { events } = await lifecycle.replay({
      turnId: TurnIdSchema.parse(identity.turnId),
      afterSequence: null,
      limit: 1000,
    });
    const compacted = events.filter(
      (event) => event.type === "context_compaction.completed",
    );
    expect(compacted).toHaveLength(2);
    expect(compacted.map((event) => event.payload.mode)).toEqual([
      "automatic",
      "manual",
    ]);
    expect(compacted[1]?.payload.summary).toContain("completed tool 1");
    expect(JSON.stringify(compacted)).not.toContain("base64");
    expect(
      events.filter((event) => event.type === "turn.completed"),
    ).toHaveLength(1);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("fails explicitly if durable media disappears instead of silently sending text", async () => {
    await submit(env, imageMessage, identity);
    bucket.objects.clear();
    await expect(
      submit(
        env,
        { role: "user", content: "Recall screenshot" },
        {
          ...identity,
          turnId: "trn_image_missing01",
          runAttemptId: "attempt_image_missing01",
        },
      ),
    ).rejects.toMatchObject({ code: "CHAT_MEDIA_NOT_FOUND" });
  });

  it("rejects corrupt images before writing media or appending a transcript message", async () => {
    const corrupt: CoreMessage = {
      role: "user",
      content: [
        {
          ...image,
          image: `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES.slice(0, 40)))}`,
        },
      ],
    };
    await expect(submit(env, corrupt, identity)).rejects.toMatchObject({
      code: "IMAGE_ATTACHMENT_INVALID",
      status: 400,
      retryable: false,
    });
    expect(bucket.objects.size).toBe(0);
    expect(
      (
        await repository.listTranscript({
          userId,
          sessionId,
          cursor: 0,
          limit: 100,
        })
      ).messages,
    ).toHaveLength(0);
  });

  it.each([false, null])(
    "rejects new image input when trusted model image support is %s",
    async (supported) => {
      await expect(
        submit(env, imageMessage, identity, 100_000, supported),
      ).rejects.toMatchObject({
        code:
          supported === false
            ? "IMAGE_INPUT_UNSUPPORTED"
            : "IMAGE_INPUT_CAPABILITY_UNKNOWN",
        status: 400,
      });
      expect(bucket.objects.size).toBe(0);
      expect(
        (
          await repository.listTranscript({
            userId,
            sessionId,
            cursor: 0,
            limit: 100,
          })
        ).messages,
      ).toHaveLength(0);
    },
  );

  it("rejects switching an image-bearing conversation to a text-only model", async () => {
    await submit(env, imageMessage, identity);
    await expect(
      submit(
        env,
        { role: "user", content: "Recall screenshot" },
        {
          ...identity,
          turnId: "trn_image_textmodel01",
          runAttemptId: "attempt_image_textmodel01",
        },
        100_000,
        false,
      ),
    ).rejects.toMatchObject({ code: "IMAGE_INPUT_UNSUPPORTED", status: 400 });
  });

  it("delivers resized pixels across the runtime handoff while preserving original durable bytes", async () => {
    env.CHAT_IMAGE_MAX_WIDTH = "50";
    env.CHAT_IMAGE_MAX_HEIGHT = "30";
    const source = new PhotonImage(
      new Uint8Array(100 * 40 * 4).fill(255),
      100,
      40,
    );
    let original: Uint8Array;
    try {
      original = source.get_bytes();
    } finally {
      source.free();
    }
    const dataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...original))}`;
    const submission = await submit(
      env,
      { role: "user", content: [{ ...image, image: dataUrl }] },
      identity,
    );
    expect([...bucket.objects.values()][0]!.bytes).toEqual(original);
    const { requests, execute } = createRuntime(submission.executionPayload);
    await execute();
    const delivered = providerImages(requests[0]!)[0]!;
    expect(typeof delivered.image).toBe("string");
    const bytes = Uint8Array.from(
      atob(String(delivered.image).split(",")[1]!),
      (char) => char.charCodeAt(0),
    );
    expect(imageSize(bytes)).toMatchObject({ width: 50, height: 20 });
    expect(delivered.mimeType).toBe("image/png");
  });

  it("does not resolve another user's or session's media even if a reference is copied", async () => {
    await submit(env, imageMessage, identity);
    const transcript = await repository.listTranscript({
      userId,
      sessionId,
      cursor: 0,
      limit: 100,
    });
    const parts = transcript.messages[0]!.parts.map(({ type, content }) => ({
      type,
      content,
    }));
    const otherSessionId = "123e4567-e89b-42d3-a456-426614174004";
    await repository.appendMessage({
      sessionId: otherSessionId,
      runId,
      userId: "other-user",
      role: "user",
      parts,
    });
    await expect(
      new HandleChatRequest(env).execute({
        sessionId: otherSessionId,
        userId: "other-user",
        runId,
        identity,
        workspaceId: identity.workspaceId,
        correlationId: "image-scope-test",
        modelInputModalities: { image: true },
        agentType: "coding",
        prompt: "recall",
        messages: [{ id: "client_other_session_media_scope", role: "user", content: "recall" }],
      }),
    ).rejects.toMatchObject({ code: "CHAT_MEDIA_NOT_FOUND" });
  });
});

type Payload = Awaited<
  ReturnType<HandleChatRequest["execute"]>
>["executionPayload"];
function submit(
  env: Env,
  message: CoreMessage,
  scope: TurnScopeBootstrap,
  contextWindowTokens = 100_000,
  imageSupport: boolean | null = true,
) {
  const submittedMessage = {
    ...message,
    id: (message as CoreMessage & { id?: string }).id ?? `client_${scope.turnId}`,
  } as CoreMessage;
  return new HandleChatRequest(env).execute({
    sessionId,
    userId,
    runId,
    identity: scope,
    workspaceId: scope.workspaceId,
    correlationId: "image-delivery-test",
    agentType: "coding",
    prompt:
      typeof message.content === "string"
        ? submittedMessage.content
        : submittedMessage.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
    messages: [submittedMessage],
    contextWindowTokens,
    modelInputModalities:
      imageSupport === null ? undefined : { image: imageSupport },
  });
}

function createAdmissionFixture(
  transcripts: MemoryTranscriptRepository,
  runs: MemoryRunRepository,
): NonNullable<Env["AUTH_TURN_ADMISSION_REPOSITORY"]> {
  return {
    async admitWithPrompt(input) {
      const session = await transcripts.ensureSession({
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId: input.promptMessage.parts.flatMap((part) => {
          const content = part.content;
          if (!content || typeof content !== "object" || Array.isArray(content)) return [];
          const metadata = (content as Record<string, unknown>).metadata;
          if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
          const canonicalIdentity = (metadata as Record<string, unknown>).canonicalIdentity;
          if (!canonicalIdentity || typeof canonicalIdentity !== "object" || Array.isArray(canonicalIdentity)) return [];
          const threadId = (canonicalIdentity as Record<string, unknown>).threadId;
          return typeof threadId === "string" ? [threadId] : [];
        })[0] ?? "thr_image_delivery01",
        taskId: input.taskId,
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
        threadId: session.threadId,
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
  } as NonNullable<Env["AUTH_TURN_ADMISSION_REPOSITORY"]>;
}

async function expectProviderImage(payload: Payload) {
  const { requests, execute } = createRuntime(payload);
  await execute();
  expect(requests).toHaveLength(1);
  expect(providerImages(requests[0]!)).toContainEqual(image);
}

function providerImages(messages: readonly CoreMessage[]) {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image")
      : [],
  );
}

function createRuntime(payload: Payload, withTools = false) {
  const requests: CoreMessage[][] = [];
  const lifecycle = new MemoryLifecycleEventStore();
  let runner: RuntimeKernelNativeRunner;
  let toolsCompleted = 0;
  const gateway: ILLMGateway = {
    generateText: async (request) => {
      requests.push(structuredClone(request.messages));
      const step = requests.length;
      return {
        parts:
          withTools && step < 3
            ? []
            : [
                {
                  id: "final_image_delivery",
                  schemaVersion: 1,
                  runId,
                  turnId: payload.identity.turnId,
                  sequence: 0,
                  createdAt: "2026-08-27T00:00:00.000Z",
                  type: "final",
                  visibility: "visible",
                  text: "Image received.",
                },
              ],
        toolCalls:
          withTools && step < 3
            ? [
                {
                  id: `call-${step}`,
                  toolName: "read_file",
                  args: { path: "README.md" },
                },
              ]
            : [],
        usage: {
          provider: "mock",
          model: "mock",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
      };
    },
    generateStructured: async () => {
      throw new Error("Unexpected structured request");
    },
    generateStream: async () => {
      throw new Error("Unexpected streaming request");
    },
  };
  const storage = new TestRuntimeStorage();
  runner = new RuntimeKernelNativeRunner(
    { storage, blockConcurrencyWhile: async (closure) => closure() },
    {
      env: { NODE_ENV: "test" },
      runId,
      sessionId,
      userId,
      correlationId: "image-delivery-test",
    },
    new CodingAgent(gateway, {
      execute: async () => {
        toolsCompleted += 1;
        if (toolsCompleted === 2)
          await runner.compact(TurnIdSchema.parse(payload.identity.turnId));
        return { success: true, output: `completed tool ${toolsCompleted}` };
      },
    }),
    {
      llmGateway: gateway,
      gitSnapshots: {
        captureSnapshot: async ({ workspace }) => ({
          ...workspace,
          headSha: "a".repeat(40),
          treeId: "b".repeat(40),
        }),
        getSnapshotDiff: async () => ({ files: [], patch: "" }),
      },
    },
  );
  return {
    runner,
    requests,
    lifecycle,
    execute: async () => {
      // Exercise the JSON handoff used between admission and the native runtime.
      const delivered = JSON.parse(JSON.stringify(payload)) as Payload;
      const response = await runner.execute({
        input: delivered.input,
        messages: delivered.messages,
        tools: {},
        lifecycleEvents: lifecycle,
        ...delivered.identity,
        turnId: TurnIdSchema.parse(delivered.identity.turnId),
        workspace: {
          filesystemRoot: "/workspace",
          workingBranch: "test",
          startTreeId: "a".repeat(40),
          artifactNamespace: "test",
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Image received.");
    },
  };
}

class MemoryMediaBucket {
  readonly objects = new Map<
    string,
    { bytes: Uint8Array; mediaType: string }
  >();
  async put(
    key: string,
    bytes: Uint8Array,
    options: { httpMetadata: { contentType: string } },
  ) {
    this.objects.set(key, {
      bytes: bytes.slice(),
      mediaType: options.httpMetadata.contentType,
    });
  }
  async get(key: string) {
    const object = this.objects.get(key);
    return object
      ? {
          size: object.bytes.length,
          httpMetadata: { contentType: object.mediaType },
          arrayBuffer: async () => object.bytes.slice().buffer,
        }
      : null;
  }
}

class TestRuntimeStorage implements RuntimeStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string | string[]) {
    if (Array.isArray(key))
      return key.filter((entry) => this.values.delete(entry)).length;
    return this.values.delete(key);
  }
  async list<T>(
    options: {
      prefix?: string;
      start?: string;
      end?: string;
      limit?: number;
    } = {},
  ) {
    return new Map(
      [...this.values.entries()]
        .filter(
          ([key]) =>
            (!options.prefix || key.startsWith(options.prefix)) &&
            (!options.start || key >= options.start) &&
            (!options.end || key < options.end),
        )
        .slice(0, options.limit)
        .map(([key, value]) => [key, value as T]),
    );
  }
}
