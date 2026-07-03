import { describe, expect, it } from "vitest";
import {
  runIdFromTurnId,
  turnIdFromRunId,
  turnSeedFromLatestUserMessage,
} from "./lifecycle-turn-routing.js";

const RUN_ID = "run_123e4567e89b42d3a456426614174100";

describe("lifecycle turn routing", () => {
  it("derives a routable turn id from a run id and user message seed", () => {
    const turnId = turnIdFromRunId(RUN_ID, "client msg 100");

    expect(turnId).toBe(
      "trn_123e4567e89b42d3a456426614174100__turn__client_msg_100",
    );
    expect(runIdFromTurnId(turnId)).toBe(RUN_ID);
  });

  it("uses the latest user message id as the canonical seed", () => {
    expect(
      turnSeedFromLatestUserMessage([
        { role: "user", id: "first" },
        { role: "assistant", id: "reply" },
        { role: "user", id: "second" },
      ]),
    ).toBe("second");
  });

  it("falls back to the latest user message index when ids are missing", () => {
    expect(
      turnSeedFromLatestUserMessage([
        { role: "assistant", id: "reply" },
        { role: "user" },
      ]),
    ).toBe("message-1");
  });
});
