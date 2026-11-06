import { z } from "zod";
import { ValidationError } from "../../domain/errors";
import { validateWithSchema } from "../../http/validation";
import {
  MAX_SCOPE_IDENTIFIER_LENGTH,
  SAFE_SCOPE_IDENTIFIER_REGEX,
  type ProviderRuntimeScopeInput,
} from "../../types/provider-scope";
import { RunIdSchema, type RunId } from "@repo/platform-protocol";

const ScopeIdSchema = z
  .string()
  .min(1)
  .max(MAX_SCOPE_IDENTIFIER_LENGTH)
  .regex(SAFE_SCOPE_IDENTIFIER_REGEX);

export interface AuthorizedProviderScope extends ProviderRuntimeScopeInput {}

export interface ParsedProviderAuthScopeRequest {
  runId?: RunId;
  requestedUserId?: string;
  requestedWorkspaceId?: string;
}

/** Parse hosted-provider request identity and header intent without authorizing resources. */
export function parseProviderAuthScopeRequest(
  request: Request,
  correlationId: string,
  validatedRunId?: RunId,
): ParsedProviderAuthScopeRequest {
  rejectLegacyQueryScope(request, correlationId);
  const runIdHeader = request.headers.get("X-Run-Id");
  const requestedRunId =
    runIdHeader === null
      ? undefined
      : validateWithSchema<RunId>(
          runIdHeader.trim(),
          RunIdSchema,
          correlationId,
        );
  if (validatedRunId && requestedRunId && validatedRunId !== requestedRunId) {
    throw new ValidationError(
      "Provider request run ID does not match its canonical run header.",
      "INVALID_SCOPE_IDENTIFIER",
      correlationId,
    );
  }
  return {
    runId: validatedRunId ?? requestedRunId,
    ...parseProviderAuthScopeHeaders(request, correlationId),
  };
}

function parseProviderAuthScopeHeaders(
  request: Request,
  correlationId: string,
): Omit<ParsedProviderAuthScopeRequest, "runId"> {
  return {
    requestedUserId: parseRequestedProviderUserId(request, correlationId),
    requestedWorkspaceId: parseRequestedProviderWorkspaceId(
      request,
      correlationId,
    ),
  };
}

function parseRequestedProviderUserId(
  request: Request,
  correlationId: string,
): string | undefined {
  return parseOptionalScopeHeader(
    request.headers.get("X-User-Id"),
    "X-User-Id",
    correlationId,
  );
}

function parseRequestedProviderWorkspaceId(
  request: Request,
  correlationId: string,
): string | undefined {
  return parseOptionalScopeHeader(
    request.headers.get("X-Workspace-Id"),
    "X-Workspace-Id",
    correlationId,
  );
}

function rejectLegacyQueryScope(request: Request, correlationId: string): void {
  const url = new URL(request.url);
  const hasLegacyScopeQuery =
    url.searchParams.has("runId") ||
    url.searchParams.has("userId") ||
    url.searchParams.has("workspaceId");
  if (hasLegacyScopeQuery) {
    throw new ValidationError(
      "Legacy BYOK query scope parameters are not supported. Use authenticated headers only.",
      "VALIDATION_ERROR",
      correlationId,
    );
  }
}

function parseOptionalScopeHeader(
  value: string | null,
  fieldName: string,
  correlationId: string,
): string | undefined {
  return parseOptionalScopeId(value, fieldName, correlationId);
}

function parseOptionalScopeId(
  value: string | null | undefined,
  fieldName: string,
  correlationId: string,
): string | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  try {
    return validateWithSchema<string>(
      value.trim(),
      ScopeIdSchema,
      correlationId,
    );
  } catch {
    throw new ValidationError(
      `Invalid ${fieldName}.`,
      "INVALID_SCOPE_IDENTIFIER",
      correlationId,
    );
  }
}
