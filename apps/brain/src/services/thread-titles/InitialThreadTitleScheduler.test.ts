import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTranscriptRepository } from "@repo/persistence";
import type { Env } from "../../types/ai";
import type { PersistenceService } from "../PersistenceService";
import { scheduleInitialThreadTitle } from "./InitialThreadTitleScheduler";
import { ThreadTitleService } from "./ThreadTitleService";
import { ThreadTitleGenerationCoordinator } from "./ThreadTitleGenerationCoordinator";

const input: Parameters<typeof scheduleInitialThreadTitle>[2] = {
  sessionId: "session",
  userId: "user",
  persistedUserMessageId: "first",
  prompt: "Fix login timeout",
  identity: {
    threadId: "thr_title",
    turnId: "trn_title",
    runAttemptId: "attempt_title",
    workspaceId: "workspace",
  },
  persistedRun: {
    id: "run_first",
    providerId: "openai",
    modelId: "gpt-4o",
    userId: "user",
    workspaceId: "workspace",
    sessionId: "session",
    taskId: "session",
    status: "created",
    mode: "build",
    branch: null,
    baseCommitSha: null,
    headCommitSha: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  },
  persistedAdmission: {
    userId: "user", workspaceId: "workspace", sessionId: "session", threadId: "thr_title",
    runId: "run_first", turnId: "trn_title", runAttemptId: "attempt_title", clientMessageId: "first",
    revisionOfTurnId: null, continuationOfTurnId: null, originalPromptId: null, continuationTerminalSequence: null,
    state: "admitted", executionState: "pending", requestFingerprint: "fixture-fingerprint", admissionOrder: 1,
    createdAt: "2026-10-01T00:00:00Z", admittedAt: "2026-10-01T00:00:00Z",
    nativeProviderBinding: {
      v: 1, kind: "byok", providerId: "openai", modelId: "gpt-4o",
      scope: { userId: "user", workspaceId: "workspace", sessionId: "session", threadId: "thr_title",
        runId: "run_first", turnId: "trn_title", runAttemptId: "attempt_title" },
      credential: { connectionId: "123e4567-e89b-42d3-a456-426614174005", userId: "user",
        providerId: "openai", ownerGeneration: 1, tokenMaterialVersion: 1 },
    },
  },
  providerRuntimeRoute: {
    providerId: "openai",
    modelId: "gpt-4o",
    transport: "openai-responses" as const,
    endpoint: "https://api.openai.com/v1/responses",
  },
  modelCapabilities: {
    supportsStructuredOutputs: true,
    supportsReasoning: false,
  },
  backgroundTaskOwner: { waitUntil: vi.fn() },
};

beforeEach(() => vi.restoreAllMocks());

describe("initial title eligibility", () => {
  it("uses the persisted first-run selection and trusted capabilities", async () => {
    const schedule = vi
      .spyOn(ThreadTitleGenerationCoordinator.prototype, "schedule")
      .mockImplementation(() => undefined);
    const preview = await new MemoryTranscriptRepository().ensureSession({
      sessionId: "session",
      userId: "user",
    });
    vi.spyOn(ThreadTitleService.prototype, "persistPreview").mockResolvedValue({
      ...preview,
      titleVersion: 2,
    });
    const persistence = {
      findFirstPersistedUserMessage: vi
        .fn()
        .mockResolvedValue({ id: "first", runId: "run_first" }),
    } as unknown as PersistenceService;
    await scheduleInitialThreadTitle({} as Env, persistence, input);
    expect(schedule).toHaveBeenCalledWith(
      input.backgroundTaskOwner,
      expect.objectContaining({
        providerId: "openai",
        modelId: "gpt-4o",
        modelCapabilities: input.modelCapabilities,
      }),
    );
  });

  it("does not retitle subsequent messages or a first message belonging to another run", async () => {
    const preview = vi.spyOn(ThreadTitleService.prototype, "persistPreview");
    for (const message of [
      { id: "older", runId: "run_first" },
      { id: "first", runId: "run_other" },
    ]) {
      const persistence = {
        findFirstPersistedUserMessage: vi.fn().mockResolvedValue(message),
      } as unknown as PersistenceService;
      await scheduleInitialThreadTitle({} as Env, persistence, input);
    }
    expect(preview).not.toHaveBeenCalled();
  });

  it("keeps title metadata failures from rejecting the coding request", async () => {
    const persistence = {
      findFirstPersistedUserMessage: vi
        .fn()
        .mockRejectedValue(new Error("metadata unavailable")),
    } as unknown as PersistenceService;
    await expect(
      scheduleInitialThreadTitle({} as Env, persistence, input),
    ).resolves.toBeUndefined();
  });
});
