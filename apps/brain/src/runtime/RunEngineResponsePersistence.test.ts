import type { DurableObjectState } from "@cloudflare/workers-types";
import type { RunRecord, TranscriptMessageRecord } from "@repo/persistence";
import {
  MESSAGE_TRANSCRIPT_PHASES,
  MESSAGE_TRANSCRIPT_STATUSES,
  RUN_WORKFLOW_STEPS,
} from "@repo/shared-types";
import {
  createMessageEmittedEvent,
  createRunProgressEvent,
  createToolCompletedEvent,
  createToolRequestedEvent,
  Run,
  RunEventRepository,
  RunRepository,
  type RunEvent,
  type RuntimeDurableObjectState,
  type RuntimeStorage,
  tagRuntimeStateSemantics,
} from "@shadowbox/execution-engine/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceService } from "../services/PersistenceService";
import type { Env } from "../types/ai";
import { persistAssistantMessageFromRunResponse } from "./RunEngineResponsePersistence";

const RUN_ID = "run_123e4567e89b42d3a456426614174900";
const SESSION_ID = "session-1";
const CORRELATION_ID = "corr-1";

describe("persistAssistantMessageFromRunResponse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists the canonical run output and terminal status", async () => {
    const ctx = new MockDurableObjectState();
    await seedRun(ctx, {
      status: "COMPLETED",
      outputContent: "Done from canonical run output.",
    });
    const persistAssistantTurn = vi
      .spyOn(PersistenceService.prototype, "persistAssistantTurn")
      .mockResolvedValue(createTranscriptMessageRecord("assistant-1"));
    const updateRunStatus = vi
      .spyOn(PersistenceService.prototype, "updateRunStatus")
      .mockResolvedValue(createRunRecord());

    const result = await persistAssistantMessageFromRunResponse(
      ctx as unknown as DurableObjectState,
      {} as Env,
      SESSION_ID,
      RUN_ID,
      CORRELATION_ID,
      createOkTextResponse("This response body is not the source of truth."),
    );

    expect(result).toEqual({ assistantMessageId: "assistant-1" });
    expect(persistAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        text: "Done from canonical run output.",
      }),
    );
    expect(updateRunStatus).toHaveBeenCalledWith(
      RUN_ID,
      "completed",
      undefined,
      expect.any(String),
    );
  });

  it("persists only the current turn activity transcript with the assistant turn", async () => {
    const ctx = new MockDurableObjectState();
    await seedRun(ctx, {
      status: "COMPLETED",
      outputContent: "Done from canonical run output.",
    });
    await seedRunEvents(ctx, [
      timestamped(
        createMessageEmittedEvent(
          baseEventInput(),
          "first prompt",
          "user",
          { clientMessageId: "client-msg-1" },
          {
            phase: MESSAGE_TRANSCRIPT_PHASES.PROMPT,
            status: MESSAGE_TRANSCRIPT_STATUSES.COMPLETED,
          },
        ),
        1,
      ),
      timestamped(
        createRunProgressEvent(
          baseEventInput(),
          RUN_WORKFLOW_STEPS.EXECUTION,
          "Old first-turn work",
          "This must not be saved on the second assistant turn.",
          "completed",
        ),
        2,
      ),
      timestamped(
        createMessageEmittedEvent(
          baseEventInput(),
          "second prompt",
          "user",
          { clientMessageId: "client-msg-2" },
          {
            phase: MESSAGE_TRANSCRIPT_PHASES.PROMPT,
            status: MESSAGE_TRANSCRIPT_STATUSES.COMPLETED,
          },
        ),
        3,
      ),
      timestamped(
        createRunProgressEvent(
          baseEventInput(),
          RUN_WORKFLOW_STEPS.EXECUTION,
          "Finding files",
          "Finding **/Footer.tsx",
          "completed",
        ),
        4,
      ),
      timestamped(
        createMessageEmittedEvent(
          baseEventInput(),
          "Reading src/components/layout/Footer.tsx",
          "assistant",
          { step: "read" },
          {
            phase: MESSAGE_TRANSCRIPT_PHASES.COMMENTARY,
            status: MESSAGE_TRANSCRIPT_STATUSES.COMPLETED,
          },
        ),
        5,
      ),
      timestamped(
        createToolRequestedEvent(
          {
            ...baseEventInput(),
            taskId: "tool-read-footer",
            toolName: "read_file",
          },
          { path: "src/components/layout/Footer.tsx" },
          {
            displayText: "Reading src/components/layout/Footer.tsx",
            description: "Read footer source",
          },
        ),
        6,
      ),
      timestamped(
        createToolCompletedEvent(
          {
            ...baseEventInput(),
            taskId: "tool-read-footer",
            toolName: "read_file",
          },
          { ok: true },
          42,
        ),
        7,
      ),
    ]);
    const persistAssistantTurn = vi
      .spyOn(PersistenceService.prototype, "persistAssistantTurn")
      .mockResolvedValue(createTranscriptMessageRecord("assistant-1"));
    vi.spyOn(PersistenceService.prototype, "updateRunStatus").mockResolvedValue(
      createRunRecord(),
    );

    await persistAssistantMessageFromRunResponse(
      ctx as unknown as DurableObjectState,
      {} as Env,
      SESSION_ID,
      RUN_ID,
      CORRELATION_ID,
      createOkTextResponse("This response body is not the source of truth."),
    );

    const persistedTurn = persistAssistantTurn.mock.calls[0]?.[0];
    expect(persistedTurn).toEqual(
      expect.objectContaining({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        turnId: "client-msg-2",
        text: "Done from canonical run output.",
      }),
    );
    expect(persistedTurn?.activity?.events).toEqual([]);
    expect(persistedTurn?.activity?.activitySnapshot).toMatchObject({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      status: "COMPLETED",
    });
    expect(persistedTurn?.activity?.activitySnapshot.items).toEqual([
      expect.objectContaining({
        kind: "text",
        role: "user",
        content: "second prompt",
        turnId: "client-msg-2",
      }),
      expect.objectContaining({
        kind: "reasoning",
        label: "Finding files",
        summary: "Finding **/Footer.tsx",
        turnId: "client-msg-2",
      }),
      expect.objectContaining({
        kind: "commentary",
        text: "Reading src/components/layout/Footer.tsx",
        turnId: "client-msg-2",
      }),
      expect.objectContaining({
        kind: "tool",
        toolName: "read_file",
        status: "completed",
        turnId: "client-msg-2",
        metadata: expect.objectContaining({
          displayText: "Reading src/components/layout/Footer.tsx",
          path: "src/components/layout/Footer.tsx",
        }),
      }),
    ]);
    expect(persistedTurn?.activity?.activitySnapshot.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Old first-turn work" }),
      ]),
    );
  });

  it("uses the latest user event as the assistant turn id when activity is empty", async () => {
    const ctx = new MockDurableObjectState();
    await seedRun(ctx, {
      status: "COMPLETED",
      outputContent: "No workflow rows, still persist this turn.",
    });
    await seedRunEvents(ctx, [
      timestamped(
        createMessageEmittedEvent(
          baseEventInput(),
          "first prompt",
          "user",
          { clientMessageId: "client-msg-1" },
          {
            phase: MESSAGE_TRANSCRIPT_PHASES.PROMPT,
            status: MESSAGE_TRANSCRIPT_STATUSES.COMPLETED,
          },
        ),
        1,
      ),
      timestamped(
        createMessageEmittedEvent(
          baseEventInput(),
          "second prompt",
          "user",
          { clientMessageId: "client-msg-2" },
          {
            phase: MESSAGE_TRANSCRIPT_PHASES.PROMPT,
            status: MESSAGE_TRANSCRIPT_STATUSES.COMPLETED,
          },
        ),
        2,
      ),
    ]);
    const persistAssistantTurn = vi
      .spyOn(PersistenceService.prototype, "persistAssistantTurn")
      .mockResolvedValue(createTranscriptMessageRecord("assistant-1"));
    vi.spyOn(PersistenceService.prototype, "updateRunStatus").mockResolvedValue(
      createRunRecord(),
    );

    await persistAssistantMessageFromRunResponse(
      ctx as unknown as DurableObjectState,
      {} as Env,
      SESSION_ID,
      RUN_ID,
      CORRELATION_ID,
      createOkTextResponse("This response body is not the source of truth."),
    );

    expect(persistAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "client-msg-2",
        text: "No workflow rows, still persist this turn.",
      }),
    );
  });

  it("fails when canonical assistant output persistence fails", async () => {
    const ctx = new MockDurableObjectState();
    await seedRun(ctx, {
      status: "COMPLETED",
      outputContent: "Done from canonical run output.",
    });
    vi.spyOn(
      PersistenceService.prototype,
      "persistAssistantTurn",
    ).mockRejectedValue(new Error("transcript write failed"));

    await expect(
      persistAssistantMessageFromRunResponse(
        ctx as unknown as DurableObjectState,
        {} as Env,
        SESSION_ID,
        RUN_ID,
        CORRELATION_ID,
        createOkTextResponse("old text fallback must not be used"),
      ),
    ).rejects.toMatchObject({
      code: "RUN_POST_EXECUTION_PERSISTENCE_FAILED",
      metadata: {
        operation: "persistAssistantTurn",
        cause: "transcript write failed",
      },
    });
  });

  it("fails when terminal run status persistence fails", async () => {
    const ctx = new MockDurableObjectState();
    await seedRun(ctx, {
      status: "COMPLETED",
      outputContent: "Done from canonical run output.",
    });
    vi.spyOn(
      PersistenceService.prototype,
      "persistAssistantTurn",
    ).mockResolvedValue(createTranscriptMessageRecord("assistant-1"));
    vi.spyOn(PersistenceService.prototype, "updateRunStatus").mockRejectedValue(
      new Error("run status write failed"),
    );

    await expect(
      persistAssistantMessageFromRunResponse(
        ctx as unknown as DurableObjectState,
        {} as Env,
        SESSION_ID,
        RUN_ID,
        CORRELATION_ID,
        createOkTextResponse("body text should not mask status failures"),
      ),
    ).rejects.toMatchObject({
      code: "RUN_POST_EXECUTION_PERSISTENCE_FAILED",
      metadata: {
        operation: "persistTerminalRunStatus",
        cause: "run status write failed",
      },
    });
  });

  it("fails completed runs that have no canonical assistant output", async () => {
    const ctx = new MockDurableObjectState();
    await seedRun(ctx, {
      status: "COMPLETED",
      outputContent: undefined,
    });
    const persistUserMessage = vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    );

    await expect(
      persistAssistantMessageFromRunResponse(
        ctx as unknown as DurableObjectState,
        {} as Env,
        SESSION_ID,
        RUN_ID,
        CORRELATION_ID,
        createOkTextResponse("legacy text body"),
      ),
    ).rejects.toMatchObject({
      code: "RUN_POST_EXECUTION_PERSISTENCE_FAILED",
      metadata: {
        operation: "readCanonicalAssistantOutput",
        cause: `Missing canonical assistant output for run ${RUN_ID}`,
      },
    });
    expect(persistUserMessage).not.toHaveBeenCalled();
  });
});

async function seedRun(
  ctx: MockDurableObjectState,
  input: {
    status: "COMPLETED" | "PAUSED" | "FAILED" | "CANCELLED";
    outputContent?: string;
  },
): Promise<void> {
  const runtimeState = tagRuntimeStateSemantics(ctx, "do");
  const runRepository = new RunRepository(runtimeState);
  await runRepository.create(
    new Run(
      RUN_ID,
      SESSION_ID,
      input.status,
      "coding",
      {
        agentType: "coding",
        prompt: "finish the run",
        sessionId: SESSION_ID,
      },
      input.outputContent
        ? {
            content: input.outputContent,
            finalSummary: input.outputContent,
          }
        : undefined,
      {
        agentType: "coding",
        prompt: "finish the run",
        sessionId: SESSION_ID,
      },
    ),
  );
}

async function seedRunEvents(
  ctx: MockDurableObjectState,
  events: RunEvent[],
): Promise<void> {
  const runtimeState = tagRuntimeStateSemantics(ctx, "do");
  const runEventRepository = new RunEventRepository(runtimeState);
  for (const event of events) {
    await runEventRepository.append(RUN_ID, event);
  }
}

function baseEventInput(): { runId: string; sessionId: string } {
  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
  };
}

function timestamped<TEvent extends RunEvent>(
  event: TEvent,
  order: number,
): TEvent {
  return {
    ...event,
    timestamp: `2026-03-24T00:00:0${order}.000Z`,
  };
}

function createOkTextResponse(content: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}

function createTranscriptMessageRecord(id: string): TranscriptMessageRecord {
  return {
    id,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    role: "assistant",
    clientMessageId: null,
    createdAt: "2026-03-24T00:00:00.000Z",
    parts: [],
  };
}

function createRunRecord(): RunRecord {
  return {
    id: RUN_ID,
    userId: "user-1",
    workspaceId: null,
    sessionId: SESSION_ID,
    taskId: SESSION_ID,
    status: "completed",
    mode: "build",
    providerId: null,
    modelId: null,
    branch: null,
    baseCommitSha: null,
    headCommitSha: null,
    startedAt: null,
    completedAt: "2026-03-24T00:00:00.000Z",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
  };
}

class InMemoryStorage implements RuntimeStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const entry of key) {
        if (this.values.delete(entry)) {
          deleted += 1;
        }
      }
      return deleted;
    }
    return this.values.delete(key);
  }

  async list<T>(options?: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const results = new Map<string, T>();

    for (const [key, value] of this.values.entries()) {
      if (options?.prefix && !key.startsWith(options.prefix)) {
        continue;
      }
      if (options?.start && key < options.start) {
        continue;
      }
      if (options?.end && key >= options.end) {
        continue;
      }

      results.set(key, value as T);
      if (options?.limit && results.size >= options.limit) {
        break;
      }
    }

    return results;
  }
}

class MockDurableObjectState implements RuntimeDurableObjectState {
  storage = new InMemoryStorage();

  async blockConcurrencyWhile<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
