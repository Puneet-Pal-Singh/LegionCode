import { describe, expect, it } from "vitest";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import { RuntimeKernelError } from "@repo/runtime-kernel";
import {
  buildNativeKernelTerminalMessage,
  resolveNativeKernelTerminalState,
} from "./NativeTerminalFailurePresentation.js";

describe("NativeTerminalFailurePresentation", () => {
  it("describes a model-boundary error without exposing adapter diagnostics", () => {
    const error = new RuntimeKernelError(
      "provider_failed",
      "Provider route rejected Bearer CANARY_PROVIDER_TOKEN apiKey=AIza_CANARY_KEY /home/CANARY/.codex/auth.json",
      new Error("Provider returned error CANARY_PRIVATE_DIAGNOSTIC"),
    );
    const state = resolveNativeKernelTerminalState(error);

    expect(state).toBe(RUN_TERMINAL_STATES.FAILED_RUNTIME);
    const message = buildNativeKernelTerminalMessage(error, state);
    expect(message).toBe("The model provider request failed.");
    expect(message).not.toContain("Provider returned error");
    expect(message).not.toContain("attempts");
    expect(message).not.toContain("CANARY");
    const gatewayError = Object.assign(new Error("CANARY_GATEWAY_DIAGNOSTIC"), {
      name: "LLMUnusableResponseError",
      statusCode: 503,
    });
    expect(resolveNativeKernelTerminalState(gatewayError)).toBe(RUN_TERMINAL_STATES.FAILED_RUNTIME);
    expect(buildNativeKernelTerminalMessage(gatewayError, state)).toBe("The model provider request failed.");
  });

  it("does not classify an unrelated retry wrapper as a provider failure", () => {
    const error = new Error("Operation failed after 3 attempts");

    expect(resolveNativeKernelTerminalState(error)).toBe(
      RUN_TERMINAL_STATES.FAILED_TOOL,
    );
    const diagnostic = () => { throw new Error("CANARY_ACCESSOR_DIAGNOSTIC"); };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const input of [
      { get name() { return diagnostic(); }, get message() { return diagnostic(); } },
      new Proxy({}, { getOwnPropertyDescriptor: diagnostic }),
      revoked.proxy,
    ]) {
      const state = resolveNativeKernelTerminalState(input);
      expect(buildNativeKernelTerminalMessage(input, state)).not.toContain("CANARY");
    }
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
    const error = new RuntimeKernelError(
      "provider_failed",
      "Model request failed at provider adapter boundary CANARY_PRIVATE_DIAGNOSTIC",
      { statusCode: 429 },
    );

    const message = buildNativeKernelTerminalMessage(
      error,
      RUN_TERMINAL_STATES.FAILED_RUNTIME,
    );

    expect(message).toContain("temporarily rate limited");
    expect(message).not.toContain("adapter boundary");
    expect(message).not.toContain("CANARY");
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
    ).toContain("timed out");
    expect(
      resolveNativeKernelTerminalState(
        new RuntimeKernelError("approval_denied", "Approval was denied"),
      ),
    ).toBe(RUN_TERMINAL_STATES.APPROVAL_DENIED);
  });
});
