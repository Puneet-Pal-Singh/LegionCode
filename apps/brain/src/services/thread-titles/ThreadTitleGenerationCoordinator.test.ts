import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import {
  ThreadTitleGenerationCoordinator,
  type ThreadTitleGenerator,
} from "./ThreadTitleGenerationCoordinator";

const input = {
  sessionId: "session",
  threadId: "thr_titles",
  runId: "run_titles",
  workspaceId: "workspace",
  userId: "user",
  firstMessageId: "msg_first",
  prompt: "Fix login timeout",
  previewVersion: 2,
  providerId: "openai",
  modelId: "chosen-model",
};

function schedule(
  generator: ThreadTitleGenerator,
  fallbackGenerator?: ThreadTitleGenerator,
) {
  const persist = vi.fn().mockResolvedValue(null);
  const persistFailure = vi.fn().mockResolvedValue(null);
  let pending: Promise<unknown> = Promise.resolve();
  new ThreadTitleGenerationCoordinator({} as Env, {
    generator,
    fallbackGenerator,
    titleService: { persist, persistFailure },
  }).schedule(
    {
      waitUntil: (promise) => {
        pending = promise;
      },
    },
    input,
  );
  return { pending, persist, persistFailure };
}

afterEach(() => vi.useRealTimers());

describe("title generation budget", () => {
  it("corrects invalid output rather than repeating an identical request", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({ text: "x".repeat(60) })
      .mockResolvedValue({ text: "Fix login timeout" });
    const run = schedule({ generateText });
    await run.pending;
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1]?.[0].messages.at(-1).content).toContain(
      "title_too_long",
    );
    expect(run.persist).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix login timeout" }),
    );
  });

  it.each([400, 401, 403, 404, 422])(
    "does not retry permanent HTTP %s failures",
    async (statusCode) => {
      const generateText = vi.fn().mockRejectedValue({ statusCode });
      const fallback = vi.fn().mockResolvedValue({ text: "Fix login timeout" });
      const run = schedule({ generateText }, { generateText: fallback });
      await run.pending;
      expect(generateText).toHaveBeenCalledOnce();
      expect(fallback).toHaveBeenCalledOnce();
    },
  );

  it("recovers after a provider ignores abort without accepting its late result", async () => {
    vi.useFakeTimers();
    let resolveLate: (result: { text: string }) => void = () => undefined;
    const generateText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLate = resolve;
          }),
      )
      .mockResolvedValue({ text: "Fix login timeout" });
    const run = schedule({ generateText });
    await vi.advanceTimersByTimeAsync(6000);
    await run.pending;
    expect(generateText.mock.calls[0]?.[0].signal.aborted).toBe(true);
    resolveLate({ text: "Wrong late title" });
    await Promise.resolve();
    expect(run.persist).toHaveBeenCalledOnce();
    expect(run.persist).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix login timeout" }),
    );
  });

  it("exhausts at most three calls and settles failure within the inference deadline", async () => {
    vi.useFakeTimers();
    const generateText = vi.fn(
      () => new Promise<{ text: string }>(() => undefined),
    );
    const fallback = vi.fn(
      () => new Promise<{ text: string }>(() => undefined),
    );
    const run = schedule({ generateText }, { generateText: fallback });
    await vi.advanceTimersByTimeAsync(18000);
    await run.pending;
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledOnce();
    expect(run.persist).not.toHaveBeenCalled();
    expect(run.persistFailure).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("corrects truncated output even if the returned fragment looks valid", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({ text: "Fix login", finishReason: "length" })
      .mockResolvedValue({ text: "Fix login timeout" });
    const run = schedule({ generateText });
    await run.pending;
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(run.persist).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix login timeout" }),
    );
  });
});
