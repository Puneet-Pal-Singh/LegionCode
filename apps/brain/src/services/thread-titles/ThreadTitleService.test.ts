import { describe, expect, it, vi } from "vitest";
import {
  MemoryThreadTitleRepository,
  MemoryRunRepository,
  MemoryTranscriptRepository,
  type AppendRunEventInput,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { ThreadTitleGenerationCoordinator } from "./ThreadTitleGenerationCoordinator";
import { ThreadTitleService } from "./ThreadTitleService";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440001";
const RUN_ID = "run_threadtitle";
const THREAD_ID = "thr_titleabc";
const FIRST_MESSAGE_ID = "msg-first-user";

describe("ThreadTitleService", () => {
  it("persists a deterministic preview immediately and records a safe title event", async () => {
    const { service, runs, transcripts } = await createHarness();

    const preview = await service.persistPreview({
      ...titleIdentity(),
      prompt: "Please inspect /private/repo and fix API_KEY=secret-value",
    });

    expect(preview).toMatchObject({
      title: "Inspect Fix",
      titleSource: "preview",
      titleVersion: 2,
    });
    await expect(runs.listRunEvents(RUN_ID)).resolves.toEqual([
      expect.objectContaining({
        eventType: "thread.title.updated",
        payload: expect.objectContaining({
          threadId: THREAD_ID,
          firstMessageId: FIRST_MESSAGE_ID,
          title: "Inspect Fix",
          titleVersion: 2,
          source: "preview",
        }),
      }),
    ]);
    await expect(transcripts.listSessions(USER_ID)).resolves.toMatchObject({
      sessions: [{ id: SESSION_ID, title: "Inspect Fix" }],
    });
  });

  it("accepts generated copy only for the matching initial preview version", async () => {
    const { service, runs } = await createHarness();
    const preview = await service.persistPreview({
      ...titleIdentity(),
      prompt: "Review isolated cloud task checkout",
    });

    const generated = await service.persist({
      ...titleIdentity(),
      title: "Review Cloud Task Checkout",
      source: "generated",
      expectedTitleVersion: preview?.titleVersion,
    });
    const stale = await service.persist({
      ...titleIdentity(),
      title: "Stale Generated Title",
      source: "generated",
      expectedTitleVersion: preview?.titleVersion,
    });

    expect(generated).toMatchObject({
      title: "Review Cloud Task Checkout",
      titleSource: "generated",
      titleVersion: 3,
    });
    expect(stale).toBeNull();
    await expect(runs.listRunEvents(RUN_ID)).resolves.toHaveLength(2);
  });

  it("never lets a late generated title overwrite a user rename", async () => {
    const { service, transcripts } = await createHarness();
    const preview = await service.persistPreview({
      ...titleIdentity(),
      prompt: "Review isolated cloud task checkout",
    });
    await transcripts.renameSessionTitle({
      userId: USER_ID,
      sessionId: SESSION_ID,
      title: "My Task Name",
      titleSource: "user",
    });

    const lateGenerated = await service.persist({
      ...titleIdentity(),
      title: "Review Cloud Task Checkout",
      source: "generated",
      expectedTitleVersion: preview?.titleVersion,
    });

    expect(lateGenerated).toBeNull();
    await expect(transcripts.listSessions(USER_ID)).resolves.toMatchObject({
      sessions: [
        {
          id: SESSION_ID,
          title: "My Task Name",
          titleSource: "user",
          titleVersion: 3,
        },
      ],
    });
  });

  it("rolls the title projection back when its canonical event cannot append", async () => {
    const { service, runs, transcripts } = await createHarness({
      failEventAppend: true,
    });

    await expect(
      service.persistPreview({
        ...titleIdentity(),
        prompt: "Review isolated cloud task checkout",
      }),
    ).rejects.toThrow("event append failed");

    await expect(transcripts.listSessions(USER_ID)).resolves.toMatchObject({
      sessions: [
        {
          id: SESSION_ID,
          title: "New task",
          titleSource: "preview",
          titleVersion: 1,
        },
      ],
    });
    await expect(runs.listRunEvents(RUN_ID)).resolves.toEqual([]);
  });

  it("uses the selected model for a bounded background title request", async () => {
    const generateStructured = vi.fn().mockResolvedValue({
      object: { title: "Review Cloud Task Checkout" },
    });
    const persist = vi.fn().mockResolvedValue(null);
    let scheduled: Promise<unknown> | undefined;
    const coordinator = new ThreadTitleGenerationCoordinator({} as Env, {
      generator: { generateStructured },
      titleService: { persist },
    });

    coordinator.schedule(
      { waitUntil: (promise) => (scheduled = promise) },
      {
        ...titleIdentity(),
        prompt: "Review isolated cloud task checkout",
        previewVersion: 2,
        providerId: "google",
        modelId: "gemma-3-27b",
      },
    );

    await scheduled;
    expect(generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "google",
        model: "gemma-3-27b",
        maxTokens: 32,
        temperature: 0,
        messages: [
          expect.objectContaining({ role: "system" }),
          {
            role: "user",
            content: "Review isolated cloud task checkout",
          },
        ],
      }),
    );
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Review Cloud Task Checkout",
        source: "generated",
        expectedTitleVersion: 2,
      }),
    );
  });
});

async function createHarness(options: { failEventAppend?: boolean } = {}) {
  const transcripts = new MemoryTranscriptRepository({
    now: () => new Date("2026-07-18T00:00:00.000Z"),
  });
  const runs = options.failEventAppend
    ? new FailingRunRepository({
        now: () => new Date("2026-07-18T00:00:00.000Z"),
      })
    : new MemoryRunRepository({
    now: () => new Date("2026-07-18T00:00:00.000Z"),
  });
  await transcripts.ensureSession({
    sessionId: SESSION_ID,
    userId: USER_ID,
    title: "New task",
  });
  await runs.ensureRun({
    id: RUN_ID,
    userId: USER_ID,
    sessionId: SESSION_ID,
    taskId: SESSION_ID,
  });
  return {
    service: new ThreadTitleService({
      AUTH_TRANSCRIPT_REPOSITORY: transcripts,
      AUTH_RUN_REPOSITORY: runs,
      AUTH_THREAD_TITLE_REPOSITORY: new MemoryThreadTitleRepository(
        transcripts,
        runs,
      ),
    } as Env),
    runs,
    transcripts,
  };
}

class FailingRunRepository extends MemoryRunRepository {
  override async appendEvent(_input: AppendRunEventInput) {
    throw new Error("event append failed");
  }
}

function titleIdentity() {
  return {
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    userId: USER_ID,
    firstMessageId: FIRST_MESSAGE_ID,
  };
}
