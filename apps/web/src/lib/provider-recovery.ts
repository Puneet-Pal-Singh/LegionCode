import type { ConversationScopeHttpError } from "@legioncode/sdk";

export interface ProviderRecoveryAdvice {
  message: string;
  actionLabel: string;
  remediation: string;
  technicalDetails?: string;
  recoveryTarget: ProviderRecoveryTarget;
}

export type ProviderRecoveryTarget =
  | "auth"
  | "connect"
  | "models"
  | "scope"
  | "general";

export function getProviderRecoveryAdvice(
  rawMessage: string | null | undefined,
  scopeError?: ConversationScopeHttpError | null,
): ProviderRecoveryAdvice {
  const message = (rawMessage ?? "").trim();

  if (scopeError) {
    const technicalDetails = `${scopeError.code} · HTTP ${scopeError.status} · ${scopeError.retryable ? "temporary" : "not retryable"}`;
    if (scopeError.status === 401 || scopeError.code === "UNAUTHORIZED") {
      return {
        message: "Your sign-in expired.",
        actionLabel: "Sign in again",
        remediation: scopeError.message,
        technicalDetails,
        recoveryTarget: "auth",
      };
    }
    if (
      scopeError.status === 409 &&
      (scopeError.code === "TURN_EXECUTION_RECOVERY_REQUIRED" ||
        scopeError.code === "TURN_ADMISSION_RECOVERY_REQUIRED")
    ) {
      return {
        message: "This saved turn needs recovery.",
        actionLabel: "Check status",
        remediation: scopeError.message,
        technicalDetails,
        recoveryTarget: "scope",
      };
    }
    return {
      message: scopeError.retryable
        ? "Could not read this conversation."
        : "This conversation could not be restored.",
      actionLabel: "Check status",
      remediation: scopeError.message,
      technicalDetails,
      recoveryTarget: "scope",
    };
  }

  if (containsRuntimeFailure(message)) {
    return {
      message: "The turn could not finish.",
      actionLabel: "View details",
      remediation: message,
      recoveryTarget: "general",
    };
  }

  if (containsTurnScopeFailure(message)) {
    return {
      message: "Could not restore this chat.",
      actionLabel: "Check status",
      remediation: message,
      recoveryTarget: "scope",
    };
  }

  if (containsActiveRunSelectionConflict(message)) {
    return {
      message: "This run is still active.",
      actionLabel: "Wait or Stop Current Run",
      remediation: "Model selection is locked until the run ends.",
      recoveryTarget: "models",
    };
  }

  if (containsMissingProviderConfiguration(message)) {
    return {
      message: "A provider is not connected.",
      actionLabel: "Open Provider Setup",
      remediation: "Connect a provider, then submit your message again.",
      recoveryTarget: "connect",
    };
  }

  if (containsPersistenceScopeMismatch(message)) {
    return {
      message: "Your login session is missing or expired.",
      actionLabel: "Log in again",
      remediation: "Sign in again to continue.",
      recoveryTarget: "auth",
    };
  }

  if (containsProviderSelectionMismatch(message)) {
    return {
      message: "The selected provider is unavailable.",
      actionLabel: "Review Session Selection",
      remediation: "Choose a connected provider and submit again.",
      recoveryTarget: "models",
    };
  }

  if (containsRateLimitError(message)) {
    return {
      message: "Provider rate limit was reached.",
      actionLabel: "Switch Provider",
      remediation: "Try again later or choose another provider.",
      recoveryTarget: "models",
    };
  }

  if (containsPlanningError(message)) {
    return {
      message: "The model could not create a plan for this request.",
      actionLabel: "Review provider",
      remediation: "Try a more specific request or another model.",
      recoveryTarget: "models",
    };
  }

  return {
    message: "The request could not be completed.",
    actionLabel: "View details",
    remediation: message || "No additional details are available.",
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
    message.includes(
      "Planning timed out before executable tasks could be generated",
    )
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
