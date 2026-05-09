import { describe, expect, it } from "vitest";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import { resolveLoopTerminalState } from "./RunTerminalStatePolicy.js";

describe("RunTerminalStatePolicy", () => {
  it("classifies normal loop stops as completed", () => {
    const terminalState = resolveLoopTerminalState({
      loopResult: {
        stopReason: "llm_stop",
        messages: [],
        toolExecutionCount: 1,
        failedToolCount: 0,
        stepsExecuted: 2,
        requiresMutation: true,
        completedMutatingToolCount: 0,
        completedReadOnlyToolCount: 1,
        toolLifecycle: [],
      },
    });

    expect(terminalState).toBe(RUN_TERMINAL_STATES.COMPLETED);
  });

  it("classifies permission-denied tool errors as failed_policy", () => {
    const terminalState = resolveLoopTerminalState({
      loopResult: {
        stopReason: "tool_error",
        messages: [],
        toolExecutionCount: 1,
        failedToolCount: 1,
        stepsExecuted: 1,
        requiresMutation: true,
        completedMutatingToolCount: 0,
        completedReadOnlyToolCount: 0,
        toolLifecycle: [],
      },
      metadata: { code: "PERMISSION_DENIED" },
    });

    expect(terminalState).toBe(RUN_TERMINAL_STATES.FAILED_POLICY);
  });

  it("keeps real non-blocking runtime issues as completed_with_warnings", () => {
    const terminalState = resolveLoopTerminalState({
      loopResult: {
        stopReason: "budget_exceeded",
        messages: [],
        toolExecutionCount: 2,
        failedToolCount: 0,
        stepsExecuted: 3,
        requiresMutation: true,
        completedMutatingToolCount: 0,
        completedReadOnlyToolCount: 2,
        toolLifecycle: [],
      },
    });

    expect(terminalState).toBe(RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS);
  });
});
