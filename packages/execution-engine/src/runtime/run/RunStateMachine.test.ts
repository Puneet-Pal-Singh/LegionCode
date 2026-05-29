import { describe, expect, it } from "vitest";
import { RunStateMachine } from "./RunStateMachine.js";

describe("RunStateMachine", () => {
  it("treats paused runs as terminal", () => {
    expect(RunStateMachine.isTerminalState("PAUSED")).toBe(true);
    expect(RunStateMachine.getValidTransitions("PAUSED")).toEqual([]);
    expect(RunStateMachine.isValidTransition("PAUSED", "RUNNING")).toBe(
      false,
    );
    expect(RunStateMachine.isValidTransition("PAUSED", "CANCELLED")).toBe(
      false,
    );
  });
});
