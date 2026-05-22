import type { CoreMessage } from "ai";
import type { TranscriptRepository } from "@repo/persistence";
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
