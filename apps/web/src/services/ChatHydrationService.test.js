import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEndpointCache } from "../lib/platform-endpoints";
import { ChatHydrationService } from "./ChatHydrationService";
import { createConversationScope } from "../hooks/conversationScope";

function scopeFor(sessionId, runId) {
  return createConversationScope({
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
    threadId: `thr_${sessionId.replace(/[^A-Za-z0-9]/g, "")}001`,
    turnId: `trn_${runId.replace(/[^A-Za-z0-9]/g, "")}001`,
    runAttemptId: `attempt_${runId.replace(/[^A-Za-z0-9]/g, "")}001`,
    sessionId,
    runId,
  });
}

describe("ChatHydrationService", () => {
  beforeEach(() => {
    _resetEndpointCache();
    vi.stubEnv("VITE_BRAIN_BASE_URL", "http://localhost:8787");
  });

  afterEach(() => {
    _resetEndpointCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hydrates paginated history and preserves runId/sessionId query contract", async () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const sessionId = "agent-session-1";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [{ role: "user", content: "hello from user" }],
            nextCursor: "cursor-page-2",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [{ role: "assistant", content: "hello from assistant" }],
          }),
          { status: 200 },
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    const service = new ChatHydrationService("http://localhost:8787");
    const result = await service.hydrateMessages(scopeFor(sessionId, runId));

    expect(result.error).toBeUndefined();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[1]?.role).toBe("assistant");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchMock.mock.calls[0]?.[0]);
    const secondUrl = new URL(fetchMock.mock.calls[1]?.[0]);
    // runId is now a query param via chatHistoryPath(runId)
    expect(firstUrl.pathname).toBe("/api/chat/history");
    expect(firstUrl.searchParams.get("runId")).toBe(runId);
    expect(firstUrl.searchParams.get("session")).toBe(sessionId);
    expect(secondUrl.pathname).toBe("/api/chat/history");
    expect(secondUrl.searchParams.get("runId")).toBe(runId);
    expect(secondUrl.searchParams.get("cursor")).toBe("cursor-page-2");
  });

  it("rejects legacy array chat history responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { role: "user", content: "legacy user message" },
          { role: "assistant", content: "legacy assistant message" },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new ChatHydrationService("http://localhost:8787");
    const result = await service.hydrateMessages(
      scopeFor(
        "agent-session-legacy",
        "123e4567-e89b-42d3-a456-426614174001",
      ),
    );

    expect(result.messages).toHaveLength(0);
    expect(result.error).toBe("Invalid history format");
  });

  it("returns a hydration error for invalid history response shape", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ invalid: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const service = new ChatHydrationService("http://localhost:8787");
    const result = await service.hydrateMessages(
      scopeFor(
        "agent-session-invalid",
        "123e4567-e89b-42d3-a456-426614174002",
      ),
    );

    expect(result.messages).toHaveLength(0);
    expect(result.error).toBe("Invalid history format");
  });
});
