import { describe, expect, it } from "vitest";
import {
  ConversationHistoryReadError,
  readConversationHistory,
} from "./conversation-history.js";
import { iterateLocalThreadHistory } from "./local-thread-history.js";
import { LocalThreadHistoryParamsSchema, LocalThreadHistoryResultSchema } from "@legioncode/app-server/protocol";

describe("readConversationHistory", () => {
  it("reads every page beyond 500 messages under one stable snapshot", async () => {
    const pages = Array.from({ length: 12 }, (_, index) => ({
      messages: Array.from({ length: 50 }, (_, offset) => index * 50 + offset),
      nextCursor: index === 11 ? null : `${(index + 1) * 50}`,
      snapshot: "600",
    }));
    const result = await readConversationHistory(async (cursor) => {
      const index = cursor === null ? 0 : Number(cursor) / 50;
      return pages[index]!;
    });

    expect(result.messages).toHaveLength(600);
    expect(result.messages.at(-1)).toBe(599);
    expect(result.snapshot).toBe("600");
    let localReads = 0;
    const iterator = iterateLocalThreadHistory(async () => localPage(++localReads), localParams());
    const first = await iterator.next();
    expect(first.value?.messages.map((message) => message.content)).toEqual(["message-1"]);
    expect(localReads).toBe(1);
    if (first.value?.messagesWindow) first.value.messagesWindow.throughCursor = localPage(2).messagesWindow!.firstCursor!;
    if (first.value?.messagesContinuation) first.value.messagesContinuation.direction = "backward";
    const second = await iterator.next();
    expect(second.value?.messages.map((message) => message.content)).toEqual(["message-2"]);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(localReads).toBe(2);
  });

  it("allows empty filtered pages when their cursor advances", async () => {
    const result = await readConversationHistory(async (cursor) =>
      cursor === null
        ? { messages: [], nextCursor: "1", snapshot: "2" }
        : { messages: ["visible"], nextCursor: null, snapshot: "2" },
    );

    expect(result.messages).toEqual(["visible"]);
    let reads = 0;
    const iterator = iterateLocalThreadHistory(async () => localPage(++reads), localParams());
    await iterator.next();
    await iterator.return();
    expect(reads).toBe(1);
  });

  it("rejects repeated cursors and snapshot changes", async () => {
    await expect(
      readConversationHistory(async (cursor) => ({
        messages: [],
        nextCursor: cursor === null ? "1" : "1",
        snapshot: "2",
      })),
    ).rejects.toBeInstanceOf(ConversationHistoryReadError);

    let reads = 0;
    await expect(
      readConversationHistory(async () => {
        reads += 1;
        return {
          messages: [],
          nextCursor: reads === 1 ? "1" : null,
          snapshot: reads === 1 ? "2" : "3",
        };
      }),
    ).rejects.toThrow("snapshot changed");
    let localReads = 0;
    const local = iterateLocalThreadHistory(async () => {
      const page = localPage(++localReads);
      if (localReads === 2 && page.messagesWindow) page.messagesWindow.throughCursor = localPage(1).messagesWindow!.firstCursor!;
      return page;
    }, localParams());
    await local.next();
    await expect(local.next()).rejects.toThrow("snapshot changed");
    const foreign = localPage(1);
    foreign.messages[0]!.data!.metadata!.canonicalIdentity = {
      threadId: "thr_foreign1", turnId: "trn_history1", runAttemptId: "attempt_history1",
    };
    await expect(iterateLocalThreadHistory(async () => foreign, localParams()).next()).rejects.toThrow("scope or cursor changed");
  });

  it("reports cancellation rather than a complete transcript", async () => {
    const controller = new AbortController();
    const pageRead = async () => {
      controller.abort();
      return { messages: ["first"], nextCursor: "1", snapshot: "2" };
    };
    await expect(
      readConversationHistory(pageRead, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    const localController = new AbortController();
    let localReads = 0;
    const iterator = iterateLocalThreadHistory(async () => {
      localReads += 1;
      localController.abort();
      return localPage(1);
    }, localParams(), { signal: localController.signal });
    await expect(iterator.next()).rejects.toThrow("cancelled");
    expect(localReads).toBe(1);
    await expect(iterateLocalThreadHistory(async () => { localReads += 1; return localPage(1); },
      localParams(), { signal: localController.signal }).next()).rejects.toThrow("cancelled");
    expect(localReads).toBe(1);
  });

  it("rejects decreasing cursors and cursors beyond the snapshot", async () => {
    await expect(readConversationHistory(async (cursor) => cursor === null
      ? { messages: [], nextCursor: "100", snapshot: "200" }
      : { messages: [], nextCursor: "99", snapshot: "200" },
    )).rejects.toThrow("did not make progress");

    await expect(readConversationHistory(async () => ({
      messages: [], nextCursor: "201", snapshot: "200",
    }))).rejects.toThrow("did not make progress");
    // Opaque cursors deliberately sort backwards; numeric/lexical ordering is not a contract.
    const bounded = iterateLocalThreadHistory(async () => localPage(1), localParams(), { maxPages: 1 });
    await bounded.next();
    await expect(bounded.next()).rejects.toThrow("page limit reached");
  });
});

function localParams() {
  return LocalThreadHistoryParamsSchema.parse({ workspaceId: "wrk_history1", threadId: "thr_history1",
    messagesContinuation: { turnIds: ["trn_history1"], throughCursor: "cursor_snapshot1", direction: "forward", cursor: null } });
}

function localPage(number: number) {
  const cursor = number === 1 ? "cursor_zzzzzz" : "cursor_aaaaaa";
  const window = { turnIds: ["trn_history1"], throughCursor: "cursor_snapshot1", firstCursor: cursor,
    lastCursor: cursor, hasEarlier: number > 1, hasLater: number === 1,
    lastUserByTurn: [{ turnId: "trn_history1", itemId: "itm_message2" }] };
  return LocalThreadHistoryResultSchema.parse({ admissions: [], nextCursor: null, messagesWindow: window,
    messages: [{ id: `itm_message${number}`, role: "user", content: `message-${number}`,
      createdAt: "2026-11-14T00:00:00.000Z", data: { metadata: { eventCursor: cursor,
        eventId: `evt_message${number}`, eventSequence: number, transcriptMessageId: `thread-input:message${number}`,
        canonicalIdentity: { threadId: "thr_history1", turnId: "trn_history1", runAttemptId: "attempt_history1" } } } }],
    ...(number === 1 ? { messagesContinuation: { turnIds: window.turnIds, throughCursor: window.throughCursor,
      direction: "forward", cursor } } : {}) });
}
