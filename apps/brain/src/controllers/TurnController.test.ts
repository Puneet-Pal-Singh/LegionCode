import { describe, expect, it, vi } from "vitest";
import { TurnController } from "./TurnController";
import type { Env } from "../types/ai";

const { resolveExecutionScope, startRunTurn } = vi.hoisted(() => ({
  resolveExecutionScope: vi.fn(),
  startRunTurn: vi.fn(),
}));

vi.mock("./chat-runtime-helpers", () => ({
  resolveExecutionScope,
  startRunTurn,
}));

describe("TurnController public bootstrap contract", () => {
  it("returns the complete server-owned scope for a pre-stream request", async () => {
    resolveExecutionScope.mockResolvedValueOnce({
      userId: "user-1",
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
    });
    startRunTurn.mockResolvedValueOnce({
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
      threadId: "thr_server1",
      turnId: "trn_server1",
      runAttemptId: "attempt_server1",
    });

    const response = await TurnController.start(
      new Request("https://brain.local/turn/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          runId: "run_server1",
        }),
      }),
      {} as Env,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
      threadId: "thr_server1",
      turnId: "trn_server1",
      runAttemptId: "attempt_server1",
    });
    expect(startRunTurn).toHaveBeenCalledWith(
      expect.anything(),
      "run_server1",
      {
        sessionId: "session-1",
        userId: "user-1",
        workspaceId: "123e4567-e89b-42d3-a456-426614174000",
        correlationId: expect.any(String),
      },
      "execution-engine-v1",
    );
  });
});
