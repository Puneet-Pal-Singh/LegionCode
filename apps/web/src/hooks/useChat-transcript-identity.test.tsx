import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChat } from "./useChat";

vi.mock("./useChatCore", () => ({
  useChatCore: () => ({
    optimisticUserMessage: { id: "client_msg_verified01", role: "user", content: "Repeat this prompt" },
    optimisticUserMessageId: "client_msg_verified01",
    runId: "run_transcript_identity01",
    scope: null,
    activeTurnProjection: { isTerminal: false, projection: null },
  }),
}));
vi.mock("./useChatArtifacts", () => ({ useChatArtifacts: () => ({}) }));

afterEach(() => { vi.unstubAllGlobals(); });

describe("session transcript presentation identity", () => {
  it("renders a confirmed optimistic prompt once while preserving distinct equal-text prompts", async () => {
    let resolveHistory!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveHistory = resolve; })));
    const { result } = renderHook(() => useChat("session-transcript-identity"));
    expect(result.current.messages.map(({ id }) => id)).toEqual(["client_msg_verified01"]);
    await waitFor(() => expect(resolveHistory).toBeDefined());
    resolveHistory(Response.json({
      messages: ["client_msg_verified01", "client_msg_distinct02"].map((id) => ({
        id, role: "user", content: "Repeat this prompt", createdAt: "2026-10-03T00:00:00.000Z",
      })),
      snapshot: "2", nextCursor: null,
    }));
    await waitFor(() => expect(result.current.hydrationStatus).toBe("readable"));
    expect(result.current.messages.map(({ id }) => id)).toEqual(["client_msg_verified01", "client_msg_distinct02"]);
    expect(result.current.messages.filter(({ id }) => id === "client_msg_verified01")).toHaveLength(1);
  });
});
