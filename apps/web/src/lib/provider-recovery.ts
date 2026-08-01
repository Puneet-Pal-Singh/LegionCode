export interface ProviderRecoveryAdvice {
  message: string;
  actionLabel: string;
  remediation: string;
  recoveryTarget: ProviderRecoveryTarget;
}

export type ProviderRecoveryTarget = "auth" | "connect" | "models" | "general";

export function getProviderRecoveryAdvice(
  rawMessage: string | null | undefined,
): ProviderRecoveryAdvice {
  const message = (rawMessage ?? "").trim();

  if (containsRuntimeFailure(message)) {
    return {
      message,
      actionLabel: "Retry Request",
      remediation:
        "This is a runtime or workspace failure. Retry the request or narrow the task; changing provider settings will not repair it.",
      recoveryTarget: "general",
    };
  }

  if (containsTurnScopeFailure(message)) {
    return {
      message: "LegionCode could not restore this task's runtime scope.",
      actionLabel: "Retry Request",
      remediation:
        "This is a task identity or runtime restoration failure, not evidence of a provider credential problem. Reload the task after the runtime is available.",
      recoveryTarget: "general",
    };
  }

  if (containsActiveRunSelectionConflict(message)) {
    return {
      message:
        "This run is still active, so model/provider selection cannot change yet.",
      actionLabel: "Wait or Stop Current Run",
      remediation:
        "Wait for the current run to finish (or stop it), then retry with your new model selection.",
      recoveryTarget: "models",
    };
  }

  if (containsMissingProviderConfiguration(message)) {
    return {
      message:
        "Provider configuration is missing. Connect a provider key or configure a platform default key.",
      actionLabel: "Open Provider Setup",
      remediation:
        "Connect or validate a provider key, then retry your chat request. In private/incognito mode, cookies and storage can reset provider persistence.",
      recoveryTarget: "connect",
    };
  }

  if (containsPersistenceScopeMismatch(message)) {
    return {
      message:
        "Your login session is missing or expired.",
      actionLabel: "Log in again",
      remediation:
        "Sign in again to refresh your app session. New chats and provider calls cannot run until authentication is restored.",
      recoveryTarget: "auth",
    };
  }

  if (containsProviderSelectionMismatch(message)) {
    return {
      message:
        "Selected provider configuration is invalid for the current session.",
      actionLabel: "Review Session Selection",
      remediation:
        "Choose a connected provider + credential in Provider Settings and retry.",
      recoveryTarget: "models",
    };
  }

  if (containsRateLimitError(message)) {
    return {
      message: "Provider rate limit was reached.",
      actionLabel: "Switch Provider",
      remediation:
        "Switch to another connected provider or retry after rate limits reset.",
      recoveryTarget: "models",
    };
  }

  if (containsPlanningError(message)) {
    return {
      message:
        "The model failed to produce a valid executable plan for this request.",
      actionLabel: "Retry with Specific Task",
      remediation:
        "Use a concrete file path or command (for example `read README.md` or `run pnpm test`). If this repeats, switch to a model with stronger structured-output support.",
      recoveryTarget: "models",
    };
  }

  return {
    message: message || "The request could not be completed.",
    actionLabel: "Retry Request",
    remediation:
      "Retry once. If the failure repeats, inspect the runtime diagnostics before changing provider settings.",
    recoveryTarget: "general",
  };
}

function containsTurnScopeFailure(message: string): boolean {
  return (
    message.includes("Turn scope reconstruction failed") ||
    message.includes("TURN_SCOPE_") ||
    message.includes("turn scope")
  );
}

function containsRuntimeFailure(message: string): boolean {
  return (
    message.includes("SANDBOX_UNAVAILABLE") ||
    message.includes("WORKSPACE_SCOPE_INVALID") ||
    message.includes("EXECUTION_TIMEOUT") ||
    message.includes("EXECUTION_CANCELLED") ||
    message.includes("RUNTIME_EXECUTION_FAILED") ||
    message.includes("Sandbox execution is unavailable") ||
    message.includes("Sandbox execution timed out")
  );
}

function containsMissingProviderConfiguration(message: string): boolean {
  return (
    message.includes("No default provider key is configured") ||
    message.includes("Missing GROQ_API_KEY") ||
    message.includes("Missing OPENROUTER_API_KEY") ||
    message.includes("Missing AXIS_OPENROUTER_API_KEY") ||
    message.includes("No BYOK provider connected")
  );
}

function containsProviderSelectionMismatch(message: string): boolean {
  return (
    message.includes("INVALID_PROVIDER_SELECTION") ||
    message.includes("providerId does not match credentialId scope") ||
    message.includes("Provider not connected")
  );
}

function containsRateLimitError(message: string): boolean {
  return (
    message.includes("AXIS_DAILY_LIMIT_EXCEEDED") ||
    message.includes("Axis free-tier limit reached") ||
    message.includes("RATE_LIMIT") ||
    message.includes("rate limit") ||
    message.includes("Key limit exceeded")
  );
}

function containsPlanningError(message: string): boolean {
  return (
    message.includes("PLAN_SCHEMA_MISMATCH") ||
    message.includes("PLAN_GENERATION_TIMEOUT") ||
    message.includes("did not match schema") ||
    message.includes("failed to produce a valid structured execution plan") ||
    message.includes("Planning timed out before executable tasks could be generated")
  );
}

function containsPersistenceScopeMismatch(message: string): boolean {
  return (
    message.includes("Unauthorized: missing or invalid authentication") ||
    message.includes("Your session is missing or expired") ||
    message.includes("Missing required X-Run-Id header") ||
    message.includes("MISSING_RUN_ID") ||
    message.includes("AUTH_FAILED")
  );
}

function containsActiveRunSelectionConflict(message: string): boolean {
  return (
    message.includes("RUN_MANIFEST_IMMUTABLE") ||
    message.includes("Run selection is immutable while a run is active")
  );
}
