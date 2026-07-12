import { describe, expect, it } from "vitest";
import { parseSecureExecutionOutcome } from "./SecureExecutionContract";

describe("SecureExecutionContract", () => {
  it("parses the canonical secure failure outcome with execution identity", () => {
    expect(
      parseSecureExecutionOutcome({
        taskId: "tool-1",
        leaseId: "lease-1",
        correlationId: "secure-corr-1",
        status: "sandbox_unavailable",
        retryable: true,
        error: {
          code: "SANDBOX_EXITED",
          message: "Sandbox container became unavailable during execution",
          details: { exitCode: 137 },
        },
      }),
    ).toEqual({
      taskId: "tool-1",
      leaseId: "lease-1",
      correlationId: "secure-corr-1",
      status: "sandbox_unavailable",
      retryable: true,
      error: {
        code: "SANDBOX_EXITED",
        message: "Sandbox container became unavailable during execution",
        details: { exitCode: 137 },
      },
    });
  });

  it("rejects an outcome missing canonical identity or retryability", () => {
    expect(
      parseSecureExecutionOutcome({
        taskId: "tool-1",
        status: "failure",
        error: { code: "FAILED", message: "failed" },
      }),
    ).toBeNull();
  });
});
