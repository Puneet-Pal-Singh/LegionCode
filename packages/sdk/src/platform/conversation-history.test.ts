import { describe, expect, it } from "vitest";
import {
  ConversationHistoryReadError,
  readConversationHistory,
} from "./conversation-history.js";

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
  });

  it("allows empty filtered pages when their cursor advances", async () => {
    const result = await readConversationHistory(async (cursor) =>
      cursor === null
        ? { messages: [], nextCursor: "1", snapshot: "2" }
        : { messages: ["visible"], nextCursor: null, snapshot: "2" },
    );

    expect(result.messages).toEqual(["visible"]);
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
  });

  it("rejects decreasing cursors and cursors beyond the snapshot", async () => {
    await expect(readConversationHistory(async (cursor) => cursor === null
      ? { messages: [], nextCursor: "100", snapshot: "200" }
      : { messages: [], nextCursor: "99", snapshot: "200" },
    )).rejects.toThrow("did not make progress");

    await expect(readConversationHistory(async () => ({
      messages: [], nextCursor: "201", snapshot: "200",
    }))).rejects.toThrow("did not make progress");
  });
});
