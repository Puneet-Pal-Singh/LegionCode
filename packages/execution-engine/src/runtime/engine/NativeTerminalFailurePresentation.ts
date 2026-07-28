import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import { RuntimeKernelError } from "@repo/runtime-kernel";

type RunTerminalState =
  (typeof RUN_TERMINAL_STATES)[keyof typeof RUN_TERMINAL_STATES];

export function resolveNativeKernelTerminalState(
  error: unknown,
): RunTerminalState {
  if (
    error instanceof RuntimeKernelError &&
    error.code === "model_final_missing"
  ) {
    return RUN_TERMINAL_STATES.FAILED_VALIDATION;
  }

  if (error instanceof RuntimeKernelError && error.code === "approval_denied") {
    return RUN_TERMINAL_STATES.APPROVAL_DENIED;
  }

  if (isModelGatewayFailure(error)) {
    return RUN_TERMINAL_STATES.FAILED_RUNTIME;
  }

  return RUN_TERMINAL_STATES.FAILED_TOOL;
}

export function buildNativeKernelTerminalMessage(
  error: unknown,
  terminalState: RunTerminalState,
): string {
  if (terminalState === RUN_TERMINAL_STATES.FAILED_RUNTIME) {
    if (hasHttpStatus(error, 429)) {
      return "The model provider is temporarily rate limited. Retry shortly or choose another available model.";
    }
    return "LegionCode could not complete the model request. Retry once; if it repeats, inspect the task diagnostics.";
  }

  if (terminalState === RUN_TERMINAL_STATES.FAILED_VALIDATION) {
    return [
      "The model response ended without a final answer.",
      "Retry the request. If it repeats, inspect the response contract diagnostics.",
    ].join("\n");
  }

  return safeErrorDetail(error) ?? "Runtime execution failed.";
}

function hasHttpStatus(error: unknown, status: number): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return new RegExp(`\\b(?:status[=: ]+|HTTP\\s+)${status}\\b`, "i").test(
    error.message,
  );
}

function isModelGatewayFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "LLMTimeoutError" ||
    error.name === "LLMUnusableResponseError" ||
    /\b(llm|model|provider|gateway)\b/i.test(error.name) ||
    /\b(text call timed out|provider request failed|provider returned error|model request|gateway request)\b/i.test(
      error.message,
    )
  );
}

function safeErrorDetail(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const normalized = error.message.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/\b(sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .slice(0, 280);
}
