import type { CoreMessage } from "ai";
import type { TranscriptMessageRecord, TranscriptRepository } from "@repo/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/ai";
import {
  PersistenceService,
  TranscriptPersistenceError,
} from "./PersistenceService";

const { withTranscriptRepositoryMock } = vi.hoisted(() => ({
  withTranscriptRepositoryMock: vi.fn(),
}));

vi.mock("./sessions/TranscriptPersistenceFactory", () => ({
  withTranscriptRepository: withTranscriptRepositoryMock,
}));

vi.mock("./runs/RunPersistenceFactory", () => ({
  withRunRepository: vi.fn(),
}));

describe("PersistenceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not clear transcript metadata when ensure input omits it", async () => {
    const repository = {
      ensureSession: vi.fn(),
    } as Partial<TranscriptRepository> as TranscriptRepository;
    withTranscriptRepositoryMock.mockImplementation(
      async (
        _env: Env,
        callback: (repository: TranscriptRepository) => Promise<unknown>,
      ) => callback(repository),
    );

    const service = new PersistenceService(createEnv());

    await service.ensureTranscriptSession({
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      userId: "123e4567-e89b-42d3-a456-426614174002",
      title: "Build transcript",
    });

    expect(repository.ensureSession).toHaveBeenCalledWith({
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      userId: "123e4567-e89b-42d3-a456-426614174002",
      workspaceId: undefined,
      taskId: "123e4567-e89b-42d3-a456-426614174001",
      title: "Build transcript",
      repository: undefined,
      status: "idle",
    });
  });

  it("does not derive a replacement session title from every persisted message", async () => {
    const repository = {
      appendMessage: vi.fn(async () => createTranscriptMessageRecord()),
    } as Partial<TranscriptRepository> as TranscriptRepository;
    withTranscriptRepositoryMock.mockImplementation(
      async (
        _env: Env,
        callback: (repository: TranscriptRepository) => Promise<unknown>,
      ) => callback(repository),
    );

    const service = new PersistenceService(createEnv());

    await service.persistUserMessage(
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174000",
      { role: "user", content: "latest prompt" },
      {
        userId: "123e4567-e89b-42d3-a456-426614174002",
      },
    );

    expect(repository.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: undefined,
        repository: undefined,
        workspaceId: undefined,
      }),
    );
  });

  it("throws a typed retryable error when transcript append fails", async () => {
    const repository = {
      appendMessage: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    } as Partial<TranscriptRepository> as TranscriptRepository;
    withTranscriptRepositoryMock.mockImplementation(
      async (
        _env: Env,
        callback: (repository: TranscriptRepository) => Promise<unknown>,
      ) => callback(repository),
    );

    const service = new PersistenceService(createEnv());
    const message: CoreMessage = { role: "user", content: "hello" };

    await expect(
      service.persistUserMessage(
        "123e4567-e89b-42d3-a456-426614174001",
        "123e4567-e89b-42d3-a456-426614174000",
        message,
        {
          userId: "123e4567-e89b-42d3-a456-426614174002",
        },
      ),
    ).rejects.toMatchObject<Partial<TranscriptPersistenceError>>({
      code: "TRANSCRIPT_PERSISTENCE_FAILED",
      retryable: true,
      status: 503,
    });
  });

  it("does not replay prior conversation history under the current run", async () => {
    const repository = createTransactionalTranscriptRepository();
    withTranscriptRepositoryMock.mockImplementation(
      async (
        _env: Env,
        callback: (repository: TranscriptRepository) => Promise<unknown>,
      ) => callback(repository),
    );

    const service = new PersistenceService(createEnv());
    await service.persistConversation(
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174000",
      [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "current prompt" },
      ],
      "corr-history-sync",
    );

    expect(repository.appendMessageToExistingSession).toHaveBeenCalledTimes(1);
    expect(repository.appendMessageToExistingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        runId: "123e4567-e89b-42d3-a456-426614174000",
        parts: [{ type: "text", content: { text: "current prompt" } }],
      }),
    );
  });

  it("persists image-bearing user messages as redacted text parts", async () => {
    const repository = {
      appendMessage: vi.fn(async () => createTranscriptMessageRecord()),
    } as Partial<TranscriptRepository> as TranscriptRepository;
    withTranscriptRepositoryMock.mockImplementation(
      async (
        _env: Env,
        callback: (repository: TranscriptRepository) => Promise<unknown>,
      ) => callback(repository),
    );

    const service = new PersistenceService(createEnv());
    await service.persistUserMessage(
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174000",
      {
        role: "user",
        content: [
          { type: "text", text: "What is wrong here?" },
          {
            type: "image",
            image: "data:image/png;base64,aGVsbG8=",
            mimeType: "image/png",
            name: "screen.png",
          },
        ],
      } as CoreMessage,
      {
        userId: "123e4567-e89b-42d3-a456-426614174002",
      },
    );

    expect(repository.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          {
            type: "text",
            content: {
              text: "What is wrong here?\n\n[Image attached: screen.png, image/png, 5 B]",
            },
          },
        ],
      }),
    );
    const appendInput = repository.appendMessage.mock.calls[0]?.[0] as {
      parts: Array<{ content: unknown }>;
      dedupeKey: string;
    };
    expect(JSON.stringify(appendInput.parts)).not.toContain("data:image/");
  });
});

function createEnv(): Env {
  return {
    AI: {} as Env["AI"],
    SECURE_API: {} as Env["SECURE_API"],
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    GITHUB_REDIRECT_URI: "x",
    GITHUB_TOKEN_ENCRYPTION_KEY: "x",
    SESSION_SECRET: "x",
    FRONTEND_URL: "x",
    SESSIONS: {} as Env["SESSIONS"],
    RUN_ENGINE_RUNTIME: {} as Env["RUN_ENGINE_RUNTIME"],
  };
}

function createTranscriptMessageRecord(): TranscriptMessageRecord {
  return {
    id: "message-1",
    sessionId: "123e4567-e89b-42d3-a456-426614174001",
    runId: "123e4567-e89b-42d3-a456-426614174000",
    role: "user",
    clientMessageId: null,
    createdAt: "2026-05-23T00:00:00.000Z",
    parts: [],
  };
}

function createTransactionalTranscriptRepository(): TranscriptRepository {
  const repository = {} as Partial<TranscriptRepository> as TranscriptRepository;
  repository.appendMessageToExistingSession = vi.fn(async () =>
    createTranscriptMessageRecord(),
  );
  repository.transaction = vi.fn(
    async (callback: (repository: TranscriptRepository) => Promise<unknown>) =>
      callback(repository),
  );

  return repository;
}
