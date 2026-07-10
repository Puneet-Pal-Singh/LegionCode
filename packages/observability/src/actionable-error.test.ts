import { describe, expect, it } from "vitest";
import { toActionableErrorAttributes } from "./actionable-error.js";

describe("actionable error attributes", () => {
  it("uses a domain code and bounds a cyclic cause chain", () => {
    const cause = new Error("network unavailable");
    const error = Object.assign(new Error("persist failed"), {
      code: "EVENT_PERSIST_FAILED",
      retryable: true,
      status: 503,
      cause,
    });
    (cause as Error & { cause?: unknown }).cause = error;

    expect(toActionableErrorAttributes(error)).toEqual({
      errorCode: "EVENT_PERSIST_FAILED",
      errorName: "Error",
      retryable: true,
      status: 503,
      causes: [
        { name: "Error", message: "persist failed" },
        { name: "Error", message: "network unavailable" },
      ],
    });
  });
});
