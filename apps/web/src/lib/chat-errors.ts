export interface ParsedChatErrorPayload {
  error?: string;
  code?: string;
  metadata?: {
    used?: number;
    limit?: number;
    resetsAt?: string;
  };
}

export function pickDebugHeaders(headers: Headers): Record<string, string> {
  const allowedHeaders = new Set([
    "content-type",
    "transfer-encoding",
    "x-request-id",
    "x-vercel-ai-data-stream",
    "x-ai-sdk-data-stream",
    "cache-control",
  ]);
  const picked: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (allowedHeaders.has(key.toLowerCase())) {
      picked[key] = value;
    }
  }
  return picked;
}

export function normalizeChatErrorMessage(error: Error): string {
  const rawMessage = error.message || "Unknown chat error";
  const parsedPayload = parseJsonErrorPayload(rawMessage);
  const message = parsedPayload?.error?.trim() || rawMessage;
  const normalized = mapKnownChatErrorMessage(message, parsedPayload);
  return normalized ?? message;
}

export function shouldLogStreamError(
  previous: { message: string; timestamp: number } | null,
  message: string,
): boolean {
  if (!previous) {
    return true;
  }
  if (previous.message !== message) {
    return true;
  }
  return Date.now() - previous.timestamp >= 30_000;
}

function parseJsonErrorPayload(rawMessage: string): ParsedChatErrorPayload | null {
  try {
    const parsed = JSON.parse(rawMessage) as ParsedChatErrorPayload;
    if (
      (typeof parsed?.error === "string" && parsed.error.trim().length > 0) ||
      typeof parsed?.code === "string"
    ) {
      return parsed;
    }
  } catch {
    // Not a JSON payload
  }
  return null;
}

function mapKnownChatErrorMessage(
  message: string,
  payload?: ParsedChatErrorPayload | null,
): string | null {
  if (payload?.code === "AXIS_DAILY_LIMIT_EXCEEDED") {
    const used = payload.metadata?.used;
    const limit = payload.metadata?.limit;
    const resetsAt = payload.metadata?.resetsAt;
    if (
      typeof used === "number" &&
      typeof limit === "number" &&
      typeof resetsAt === "string"
    ) {
      return `Axis free-tier limit reached (${used}/${limit}). Connect a BYOK provider or retry after ${new Date(resetsAt).toLocaleString()}.`;
    }
    return "Axis free-tier limit reached. Connect a BYOK provider or retry after reset.";
  }
  if (payload?.code === "PLAN_SCHEMA_MISMATCH") {
    return "The model could not build a valid structured plan for this request. Retry with a concrete file path or command, or switch to a stronger model.";
  }
  if (payload?.code === "PLAN_GENERATION_TIMEOUT") {
    return "Planning timed out before executable tasks were generated. Retry with a narrower request.";
  }
  if (payload?.code === "PROVIDER_UNAVAILABLE") {
    if (message.toLowerCase().includes("session store")) {
      return "Session service is temporarily unavailable. Retry in a few seconds.";
    }
    return "Provider request failed after retries. Check provider health/model availability or switch providers and retry.";
  }
  if (payload?.code === "RATE_LIMITED") {
    return "Provider rate limit reached. Retry after cooldown or switch to another connected provider.";
  }
  if (payload?.code === "AUTH_FAILED") {
    if (containsSessionAuthFailure(message)) {
      return "Your session is missing or expired. Log in again and retry.";
    }
    return "Provider authentication failed. Reconnect credentials in Provider Settings and retry.";
  }
  if (containsMissingDefaultKeyError(message)) {
    return "No explicit provider configuration is available. Connect a provider key in Settings. If you are in private/incognito mode, persistence may be reset.";
  }
  if (containsOpenRouterKeyLimitError(message)) {
    return "OpenRouter key limit is exhausted ($0 total limit). Increase key limit in https://openrouter.ai/settings/keys or use a different provider key.";
  }
  if (containsToolChoiceUnsupportedError(message)) {
    return "The selected model does not support required tool-calling/structured planning. Choose a different model.";
  }
  if (containsProviderRetryFailure(message)) {
    return "Provider request failed after retries. Check provider health/model availability or switch providers and retry.";
  }
  if (containsTransientNetworkError(message)) {
    return "Temporary network/service issue while streaming chat. Please retry in a few seconds.";
  }
  return null;
}

function containsMissingDefaultKeyError(message: string): boolean {
  return (
    message.includes("No default provider key is configured") ||
    message.includes("Provider resolution failed") ||
    message.includes("Missing API key for configured LITELLM_BASE_URL") ||
    message.includes("Missing AXIS_OPENROUTER_API_KEY")
  );
}

function containsOpenRouterKeyLimitError(message: string): boolean {
  return message.includes("Key limit exceeded (total limit)");
}

function containsToolChoiceUnsupportedError(message: string): boolean {
  return message.includes("support the provided 'tool_choice' value");
}

function containsSessionAuthFailure(message: string): boolean {
  return (
    message.includes("missing authentication token") ||
    message.includes("missing or invalid authentication") ||
    message.includes("Unauthorized")
  );
}

function containsTransientNetworkError(message: string): boolean {
  return (
    message.includes("Failed to fetch") ||
    message.includes("NetworkError") ||
    message.includes("Network connection lost") ||
    message.includes("Service Unavailable")
  );
}

function containsProviderRetryFailure(message: string): boolean {
  return (
    message.includes("Failed after 3 attempts") ||
    message.includes("Provider returned error")
  );
}
