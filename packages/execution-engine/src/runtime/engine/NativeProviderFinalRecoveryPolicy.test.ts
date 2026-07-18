import { describe, expect, it } from "vitest";
import { shouldRetryNativeFinalOnlyResponse } from "./NativeProviderFinalRecoveryPolicy.js";

describe("shouldRetryNativeFinalOnlyResponse", () => {
  it("retries one no-tool response that contains only quarantined material", () => {
    expect(
      shouldRetryNativeFinalOnlyResponse({
        recoveryAlreadyAttempted: false,
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
  });

  it("does not retry visible text, a tool response, or a second missing final", () => {
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
        recoveryAlreadyAttempted: false,
        toolCallCount: 0,
        responseParts: [visiblePart],
      }),
    ).toBe(false);
    expect(
      shouldRetryNativeFinalOnlyResponse({
        recoveryAlreadyAttempted: false,
        toolCallCount: 1,
        responseParts: [],
      }),
    ).toBe(false);
    expect(
      shouldRetryNativeFinalOnlyResponse({
        recoveryAlreadyAttempted: true,
        toolCallCount: 0,
        responseParts: [],
      }),
    ).toBe(false);
  });
});
