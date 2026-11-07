import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import { RuntimeKernelError, toProtocolError } from "@repo/runtime-kernel";
import { toPublicProtocolError, type ProtocolError } from "@repo/platform-protocol";

type RunTerminalState =
  (typeof RUN_TERMINAL_STATES)[keyof typeof RUN_TERMINAL_STATES];

export function resolveNativeKernelTerminalState(
  error: unknown,
): RunTerminalState {
  const code = runtimeErrorCode(error);
  if (code === "model_final_missing") {
    return RUN_TERMINAL_STATES.FAILED_VALIDATION;
  }

  if (code === "approval_denied") {
    return RUN_TERMINAL_STATES.APPROVAL_DENIED;
  }

  if (code === "approval_timed_out") {
    return RUN_TERMINAL_STATES.APPROVAL_TIMED_OUT;
  }

  const failure = publicFailure(error);
  if (
    failure.code === "provider_unavailable" ||
    failure.code === "model_unavailable" ||
    failure.code === "rate_limited"
  ) {
    return RUN_TERMINAL_STATES.FAILED_RUNTIME;
  }

  return RUN_TERMINAL_STATES.FAILED_TOOL;
}

export function buildNativeKernelTerminalMessage(
  error: unknown,
  terminalState: RunTerminalState,
): string {
  if (terminalState === RUN_TERMINAL_STATES.APPROVAL_TIMED_OUT) {
    return toPublicProtocolError({ code: "command_timed_out" }).message;
  }
  if (terminalState === RUN_TERMINAL_STATES.APPROVAL_DENIED) {
    return toPublicProtocolError({ code: "policy_denied" }).message;
  }

  if (terminalState === RUN_TERMINAL_STATES.FAILED_VALIDATION) {
    return toPublicProtocolError({ code: "validation_failed" }).message;
  }
  const failure = publicFailure(error);
  if (
    terminalState === RUN_TERMINAL_STATES.FAILED_RUNTIME &&
    failure.code !== "provider_unavailable" &&
    failure.code !== "model_unavailable" &&
    failure.code !== "rate_limited"
  ) {
    return toPublicProtocolError({ code: "provider_unavailable", retryable: true }).message;
  }
  return failure.message;
}

/** Diagnostics use the same classification as public output, without prose or causes. */
export function projectNativeKernelFailureDiagnostic(
  error: unknown,
): Pick<ProtocolError, "code" | "retryable"> & { providerStatusCode?: number } {
  const failure = publicFailure(error);
  const providerStatusCode = failure.details?.providerStatusCode;
  return {
    code: failure.code,
    retryable: failure.retryable,
    ...(typeof providerStatusCode === "number" ? { providerStatusCode } : {}),
  };
}

function publicFailure(error: unknown): ProtocolError {
  // Fixed gateway identity and numeric status are evidence; diagnostic prose is not.
  const name = errorData(error, "name");
  if (name === "LLMTimeoutError" || name === "LLMUnusableResponseError") {
    return toProtocolError(
      new RuntimeKernelError("provider_failed", "Model gateway failure", error),
    );
  }
  return toProtocolError(error);
}

function runtimeErrorCode(error: unknown): unknown {
  try {
    return error instanceof RuntimeKernelError ? errorData(error, "code") : undefined;
  } catch {
    return undefined;
  }
}

function errorData(error: unknown, key: string): unknown {
  try {
    if (error === null || typeof error !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
