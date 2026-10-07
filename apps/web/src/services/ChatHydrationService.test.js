import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEndpointCache } from "../lib/platform-endpoints";
import { ChatHydrationService } from "./ChatHydrationService";

describe("ChatHydrationService", () => {
  const message = (id, role, content) => ({ id, role, content, createdAt: "2026-10-03T00:00:00.000Z" });
  beforeEach(() => {
    _resetEndpointCache();
    vi.stubEnv("VITE_BRAIN_BASE_URL", "http://localhost:8787");
  });
  afterEach(() => {
    _resetEndpointCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads every session page under one snapshot without an execution run", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [message("m1", "user", "hello")],
        nextCursor: "1",
        snapshot: "2",
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [message("m2", "assistant", "world")],
        nextCursor: null,
        snapshot: "2",
      })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ChatHydrationService().hydrateMessages("saved-session");
    expect(result.status).toBe("readable");
    expect(result.messages.map(({ id }) => id)).toEqual(["m1", "m2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchMock.mock.calls[0][0]);
    const secondUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(firstUrl.searchParams.get("session")).toBe("saved-session");
    expect(firstUrl.searchParams.has("runId")).toBe(false);
    expect(secondUrl.searchParams.get("cursor")).toBe("1");
    expect(secondUrl.searchParams.get("snapshot")).toBe("2");
  });

  it("distinguishes a real empty transcript from a failed read", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [], nextCursor: null, snapshot: "0" })))
      .mockResolvedValueOnce(new Response("missing", { status: 404 })));
    const service = new ChatHydrationService();
    expect((await service.hydrateMessages("empty-session")).status).toBe("empty");
    expect((await service.hydrateMessages("lost-session")).status).toBe("recovery-required");
  });

  it("returns partial status when a later page fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [message("m1", "user", "saved")],
        nextCursor: "1",
        snapshot: "2",
      })))
      .mockResolvedValueOnce(new Response("offline", { status: 503 })));

    const result = await new ChatHydrationService().hydrateMessages("session");
    expect(result.status).toBe("partial");
    expect(result.messages.map(({ id }) => id)).toEqual(["m1"]);
    expect(result.error).toContain("503");
  });

  it("rejects malformed message IDs and missing timestamps at the transport boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [{ role: "assistant", content: "not durable" }],
      nextCursor: null,
      snapshot: "1",
    }))));
    const result = await new ChatHydrationService().hydrateMessages("session");
    expect(result.status).toBe("failed");
    expect(result.messages).toEqual([]);
  });

  it("returns a partial transcript when numeric cursors decrease", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [message("m1", "user", "saved")], nextCursor: "100", snapshot: "200",
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [message("m2", "assistant", "stale page")], nextCursor: "99", snapshot: "200",
      }))));
    const result = await new ChatHydrationService().hydrateMessages("session");
    expect(result.status).toBe("partial");
    expect(result.messages.map(({ id }) => id)).toEqual(["m1"]);
  });
});
