import { describe, expect, it } from "vitest";
import { shouldRetryNativeFinalOnlyResponse } from "./NativeProviderFinalRecoveryPolicy.js";

describe("shouldRetryNativeFinalOnlyResponse", () => {
  it("allows two bounded final-only recoveries for quarantined material", () => {
    expect(
      shouldRetryNativeFinalOnlyResponse({
        recoveryAttemptCount: 0,
        toolCallCount: 0,
        responseParts: [
          {
            id: "provider-reasoning",
            schemaVersion: 1,
            runId: "run-1",
            turnId: "turn-1",
            sequence: 0,
            createdAt: "2026-07-18T00:00:00.000Z",
            type: "reasoning",
            visibility: "audit_only",
            text: "Private model material",
          },
        ],
      }),
    ).toBe(true);
    expect(
      shouldRetryNativeFinalOnlyResponse({
        recoveryAttemptCount: 1,
        toolCallCount: 0,
        responseParts: [],
      }),
    ).toBe(true);
  });

  it("does not retry visible text, a tool response, or after two recoveries", () => {
    const visiblePart = {
      id: "provider-visible",
      schemaVersion: 1 as const,
      runId: "run-1",
      turnId: "turn-1",
      sequence: 0,
      createdAt: "2026-07-18T00:00:00.000Z",
      type: "visible_text" as const,
      visibility: "visible" as const,
      text: "A real answer",
    };

    expect(
      shouldRetryNativeFinalOnlyResponse({
        recoveryAttemptCount: 0,
        toolCallCount: 0,
        responseParts: [visiblePart],
      }),
    ).toBe(false);
    expect(
      shouldRetryNativeFinalOnlyResponse({
        recoveryAttemptCount: 0,
        toolCallCount: 1,
        responseParts: [],
      }),
    ).toBe(false);
    expect(
      shouldRetryNativeFinalOnlyResponse({
        recoveryAttemptCount: 2,
        toolCallCount: 0,
        responseParts: [],
      }),
    ).toBe(false);
  });
});
