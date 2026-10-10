import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEndpointCache } from "../lib/platform-endpoints";
import { ChatHydrationService } from "./ChatHydrationService";

describe("ChatHydrationService", () => {
  const message = (id, role, content) => ({ id, role, content, createdAt: "2026-10-03T00:00:00.000Z" });
  it("hydrates a valid fifty-message page larger than the transport default limit", async () => {
    const messages = Array.from({ length: 50 }, (_, index) => message(`m${index}`, "assistant", "x".repeat(22_000)));
    const body = JSON.stringify({ messages, nextCursor: null, snapshot: "50" });
    expect(body.length).toBeGreaterThan(1_048_576);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse(body, {
      headers: { "content-length": String(body.length) },
    })));
    const result = await new ChatHydrationService().hydrateMessages("550e8400-e29b-41d4-a716-446655440001");
    expect(result.status).toBe("readable");
    expect(result.messages).toHaveLength(50);
    expect(result.messages[49].content).toBe(messages[49].content);
  });

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
      .mockResolvedValueOnce(historyResponse(JSON.stringify({
        messages: [message("m1", "user", "hello")],
        nextCursor: "1",
        snapshot: "2",
      })))
      .mockResolvedValueOnce(historyResponse(JSON.stringify({
        messages: [message("m2", "assistant", "world")],
        nextCursor: null,
        snapshot: "2",
      })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ChatHydrationService().hydrateMessages("550e8400-e29b-41d4-a716-446655440001");
    expect(result.status).toBe("readable");
    expect(result.messages.map(({ id }) => id)).toEqual(["m1", "m2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8787/app-server/request");
    expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
    expect(first.method).toBe("session/history");
    expect(first.params.session).toBe("550e8400-e29b-41d4-a716-446655440001");
    expect(first.params).not.toHaveProperty("runId");
    expect(second.params.cursor).toBe("1");
    expect(second.params.snapshot).toBe("2");
  });

  it("distinguishes a real empty transcript from a failed read", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(historyResponse(JSON.stringify({ messages: [], nextCursor: null, snapshot: "0" })))
      .mockResolvedValueOnce(historyResponse("missing", { status: 404 })));
    const service = new ChatHydrationService();
    expect((await service.hydrateMessages("550e8400-e29b-41d4-a716-446655440002")).status).toBe("empty");
    expect((await service.hydrateMessages("550e8400-e29b-41d4-a716-446655440003")).status).toBe("recovery-required");
  });

  it("returns partial status when a later page fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(historyResponse(JSON.stringify({
        messages: [message("m1", "user", "saved")],
        nextCursor: "1",
        snapshot: "2",
      })))
      .mockResolvedValueOnce(historyResponse("offline", { status: 503 })));

    const result = await new ChatHydrationService().hydrateMessages("550e8400-e29b-41d4-a716-446655440004");
    expect(result.status).toBe("partial");
    expect(result.messages.map(({ id }) => id)).toEqual(["m1"]);
    expect(result.error).toContain("503");
  });

  it.each([{ payload: [{ role: "assistant", content: "legacy array" }] }, { payload: { invalid: true } }])(
    "rejects the previous malformed or legacy history shape: %j",
    async ({ payload }) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse(JSON.stringify(payload))));
      const result = await new ChatHydrationService().hydrateMessages("550e8400-e29b-41d4-a716-446655440004");
      expect(result.status).toBe("failed");
      expect(result.messages).toEqual([]);
      expect(result.error).toContain("Invalid history format");
    },
  );

  it("rejects malformed message IDs and missing timestamps at the transport boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse(JSON.stringify({
      messages: [{ role: "assistant", content: "not durable" }],
      nextCursor: null,
      snapshot: "1",
    }))));
    const result = await new ChatHydrationService().hydrateMessages("550e8400-e29b-41d4-a716-446655440004");
    expect(result.status).toBe("failed");
    expect(result.messages).toEqual([]);
  });

  it("returns a partial transcript when numeric cursors decrease", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(historyResponse(JSON.stringify({
        messages: [message("m1", "user", "saved")], nextCursor: "100", snapshot: "200",
      })))
      .mockResolvedValueOnce(historyResponse(JSON.stringify({
        messages: [message("m2", "assistant", "stale page")], nextCursor: "99", snapshot: "200",
      }))));
    const result = await new ChatHydrationService().hydrateMessages("550e8400-e29b-41d4-a716-446655440004");
    expect(result.status).toBe("partial");
    expect(result.messages.map(({ id }) => id)).toEqual(["m1"]);
  });
});

function historyResponse(body, init) {
  const status = init?.status ?? 200;
  const payload = status >= 400
    ? { ok: false, error: { code: status === 404 ? "not_found" : "server_unavailable", message: body } }
    : { ok: true, result: JSON.parse(body) };
  return new Response(JSON.stringify({ protocolVersion: "1.0.0", method: "session/history", ...payload }), init);
}
