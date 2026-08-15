import { describe, expect, it, vi } from "vitest";
import {
  MemoryEventStore,
  MemoryThreadTitleRepository,
  MemoryTranscriptRepository,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { ThreadTitleGenerationCoordinator } from "./ThreadTitleGenerationCoordinator";
import { ThreadTitleService } from "./ThreadTitleService";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440001";
const RUN_ID = "run_threadtitle";
const THREAD_ID = "thr_titleabc";
const WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440002";
const FIRST_MESSAGE_ID = "msg-first-user";

describe("ThreadTitleService", () => {
  it("replays preview then generated title through canonical thread events", async () => {
    const { events, service } = await createHarness();

    const preview = await service.persistPreview({
      ...titleIdentity(),
      prompt: "Please inspect /private/repo and fix API_KEY=secret-value",
    });
    const generated = await service.persist({
      ...titleIdentity(),
      title: "Inspect Secure Repository",
      source: "generated",
      expectedTitleVersion: preview?.titleVersion,
    });

    expect(preview).toMatchObject({
      title: "Please i…",
      titleSource: "preview",
      titleVersion: 2,
    });
    expect(generated).toMatchObject({
      title: "Inspect Secure Repository",
      titleSource: "generated",
      titleVersion: 3,
    });
    await expect(
      events.replay({
        scope: { scopeType: "thread", scopeId: THREAD_ID },
        afterCursor: null,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      events: [
        {
          type: "thread.title.updated",
          runId: RUN_ID,
          threadId: THREAD_ID,
          payload: {
            firstMessageId: FIRST_MESSAGE_ID,
            title: "Please i…",
            titleVersion: 2,
            source: "preview",
          },
        },
        {
          type: "thread.title.updated",
          payload: {
            title: "Inspect Secure Repository",
            titleVersion: 3,
            source: "generated",
          },
        },
      ],
    });
  });

  it("replays a user rename as the same canonical title event", async () => {
    const { events, service } = await createHarness();

    const renamed = await service.rename({
      ...titleIdentity(),
      title: "My Task Name",
    });

    expect(renamed).toMatchObject({
      title: "My Task Name",
      titleSource: "user",
      titleVersion: 2,
    });
    await expect(
      events.replay({
        scope: { scopeType: "thread", scopeId: THREAD_ID },
        afterCursor: null,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      events: [
        {
          type: "thread.title.updated",
          payload: {
            title: "My Task Name",
            titleVersion: 2,
            source: "user",
          },
        },
      ],
    });
  });

  it("never lets a late generated title overwrite a user rename", async () => {
    const { service, transcripts } = await createHarness();
    const preview = await service.persistPreview({
      ...titleIdentity(),
      prompt: "Review isolated cloud task checkout",
    });
    await service.rename({ ...titleIdentity(), title: "My Task Name" });

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

  it("rolls the title projection back when the canonical event cannot append", async () => {
    const { service, transcripts } = await createHarness({
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
  });

  it("uses the selected model for a bounded background title request", async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '<think>Choose a concise title.</think>\nTitle: "Review Cloud Task Checkout Improvements."\nIgnored explanation',
    });
    const persist = vi.fn().mockResolvedValue(null);
    let scheduled: Promise<unknown> | undefined;
    const coordinator = new ThreadTitleGenerationCoordinator({} as Env, {
      generator: { generateText },
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
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "google",
        model: "gemma-3-27b",
        temperature: 0,
        maxOutputTokens: 32,
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
        title: "Review Cloud Task Checkout Improvements",
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
  const events = options.failEventAppend
    ? new FailingEventStore()
    : new MemoryEventStore({ now: () => "2026-07-18T00:00:00.000Z" });
  await transcripts.ensureSession({
    sessionId: SESSION_ID,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    title: "New task",
  });
  return {
    service: new ThreadTitleService({
      AUTH_TRANSCRIPT_REPOSITORY: transcripts,
      AUTH_THREAD_TITLE_REPOSITORY: new MemoryThreadTitleRepository(
        transcripts,
        events,
      ),
    } as Env),
    events,
    transcripts,
  };
}

class FailingEventStore extends MemoryEventStore {
  override async append() {
    throw new Error("event append failed");
  }
}

function titleIdentity() {
  return {
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    firstMessageId: FIRST_MESSAGE_ID,
  };
}
