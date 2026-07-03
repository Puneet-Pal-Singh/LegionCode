import { describe, expect, it } from "vitest";
import {
  runIdFromTurnId,
  turnIdFromRunId,
  turnSeedFromLatestUserMessage,
} from "./LifecycleTurnRouting";

describe("LifecycleTurnRouting", () => {
  it("derives one lifecycle turn id per latest user message", () => {
    const runId = "run_123e4567e89b42d3a456426614174999";

    const firstTurnId = turnIdFromRunId(runId, "client_msg_first");
    const secondTurnId = turnIdFromRunId(runId, "client_msg_second");

    expect(firstTurnId).not.toBe(secondTurnId);
    expect(runIdFromTurnId(firstTurnId)).toBe(runId);
    expect(runIdFromTurnId(secondTurnId)).toBe(runId);
  });

  it("falls back to the user message index when an id is missing", () => {
    const seed = turnSeedFromLatestUserMessage([
      { role: "user" },
      { role: "assistant", id: "assistant-1" },
      { role: "user" },
    ]);

    expect(seed).toBe("message-2");
  });
});
