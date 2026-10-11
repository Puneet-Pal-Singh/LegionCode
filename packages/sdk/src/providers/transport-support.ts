import { RunIdSchema, type RunId } from "@repo/platform-protocol";
import {
  ProviderClientOperationError,
  isRetryableProviderClientErrorCode,
  parseProviderErrorEnvelope,
  parseProviderOperationErrorCode,
} from "./errors.js";

export function resolveCanonicalRunId(getRunId: () => string | null): RunId {
  const runId = getRunId();
  if (!runId) {
    throw new ProviderClientOperationError(
      "MISSING_RUN_ID",
      "Run ID is required for provider requests",
      false,
      undefined,
      400,
    );
  }

  const parsed = RunIdSchema.safeParse(runId);
  if (!parsed.success) {
    throw new ProviderClientOperationError(
      "INVALID_REQUEST_CONTRACT",
      "Provider requests require a canonical run ID",
      false,
      undefined,
      400,
    );
  }
  return parsed.data;
}

export async function createOperationErrorFromResponse(
  response: Response,
  responsePreviewLimit: number,
): Promise<ProviderClientOperationError> {
  let code = "API_ERROR";
  let message = `HTTP ${response.status}`;
  let correlationId: string | undefined;
  let retryable = response.status >= 500 || response.status === 429;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const previewResponse =
      typeof response.clone === "function" ? response.clone() : response;
    try {
      const payload = await response.json();
      const envelope = parseProviderErrorEnvelope(payload);
      if (envelope) {
        return new ProviderClientOperationError(
          envelope.error.code,
          envelope.error.message,
          envelope.error.retryable ||
            isRetryableProviderClientErrorCode(envelope.error.code),
          envelope.error.correlationId,
          response.status,
        );
      }

      const fallback = extractErrorFields(payload);
      code = fallback.code ?? code;
      message = fallback.message ?? message;
      correlationId = fallback.correlationId;
      retryable =
        retryable ||
        isRetryableProviderClientErrorCode(parseProviderOperationErrorCode(code));
    } catch (error) {
      const preview = await readResponsePreview(previewResponse, responsePreviewLimit);
      code = "INVALID_ERROR_RESPONSE";
      message = preview
        ? `Malformed JSON error response: ${preview}`
        : "Malformed JSON error response";
      retryable = false;
      console.warn(
        "[provider/httpTransport] Failed to parse JSON error response",
        { error },
      );
    }
  } else {
    const preview = await readResponsePreview(response, responsePreviewLimit);
    if (preview.length > 0) {
      code = "INVALID_ERROR_RESPONSE";
      message = `Unexpected non-JSON error response: ${preview}`;
    }
  }

  return new ProviderClientOperationError(
    parseProviderOperationErrorCode(code),
    message,
    retryable,
    correlationId,
    response.status,
  );
}

function extractErrorFields(payload: unknown): {
  code?: string;
  message?: string;
  correlationId?: string;
} {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const raw = payload as Record<string, unknown>;
  const nestedError =
    raw.error && typeof raw.error === "object"
      ? (raw.error as Record<string, unknown>)
      : undefined;

  const message =
    typeof raw.error === "string"
      ? raw.error
      : typeof raw.message === "string"
        ? raw.message
        : typeof nestedError?.message === "string"
          ? nestedError.message
          : undefined;

  const code =
    typeof raw.code === "string"
      ? raw.code
      : typeof nestedError?.code === "string"
        ? nestedError.code
        : undefined;

  const correlationId =
    typeof raw.correlationId === "string"
      ? raw.correlationId
      : typeof nestedError?.correlationId === "string"
        ? nestedError.correlationId
        : undefined;

  return { code, message, correlationId };
}

async function readResponsePreview(
  response: Response,
  limit: number,
): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }
    return text.slice(0, limit);
  } catch {
    return "";
  }
}

