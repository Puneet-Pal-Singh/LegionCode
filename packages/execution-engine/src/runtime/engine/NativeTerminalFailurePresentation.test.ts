import { describe, expect, it } from "vitest";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import { RuntimeKernelError } from "@repo/runtime-kernel";
import {
  buildNativeKernelTerminalMessage,
  resolveNativeKernelTerminalState,
} from "./NativeTerminalFailurePresentation.js";

describe("NativeTerminalFailurePresentation", () => {
  it("describes a model-boundary error without exposing adapter diagnostics", () => {
    const error = new Error(
      "Provider request failed after 3 attempts: Provider returned error",
    );
    const state = resolveNativeKernelTerminalState(error);

    expect(state).toBe(RUN_TERMINAL_STATES.FAILED_RUNTIME);
    const message = buildNativeKernelTerminalMessage(error, state);
    expect(message).toContain("could not complete the model request");
    expect(message).not.toContain("Provider returned error");
    expect(message).not.toContain("attempts");
  });

  it("does not classify an unrelated retry wrapper as a provider failure", () => {
    const error = new Error("Operation failed after 3 attempts");

    expect(resolveNativeKernelTerminalState(error)).toBe(
      RUN_TERMINAL_STATES.FAILED_TOOL,
    );
  });

  it("does not expose credential-shaped model failure details", () => {
    const error = new Error(
      "Provider request failed with token sk-test-secret-value-123456789",
    );

    expect(
      buildNativeKernelTerminalMessage(
        error,
        RUN_TERMINAL_STATES.FAILED_RUNTIME,
      ),
    ).not.toContain("sk-test-secret");
  });

  it("presents provider 429 failures as a concise retryable capacity issue", () => {
    const error = new Error(
      "Model request failed at provider adapter boundary (status=429)",
    );

    const message = buildNativeKernelTerminalMessage(
      error,
      RUN_TERMINAL_STATES.FAILED_RUNTIME,
    );

    expect(message).toContain("temporarily rate limited");
    expect(message).not.toContain("adapter boundary");
  });

  it("presents an approval timeout separately from an explicit denial", () => {
    const error = new RuntimeKernelError(
      "approval_timed_out",
      "Approval request expired.",
    );

    expect(resolveNativeKernelTerminalState(error)).toBe(
      RUN_TERMINAL_STATES.APPROVAL_TIMED_OUT,
    );
    expect(
      buildNativeKernelTerminalMessage(error, RUN_TERMINAL_STATES.APPROVAL_TIMED_OUT),
    ).toContain("expired before a decision was recorded");
    expect(
      resolveNativeKernelTerminalState(
        new RuntimeKernelError("approval_denied", "Approval was denied"),
      ),
    ).toBe(RUN_TERMINAL_STATES.APPROVAL_DENIED);
  });
});
