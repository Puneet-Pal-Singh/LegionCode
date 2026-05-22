import { z } from "zod";
import type { Env } from "../../types/ai";
import { DomainError, ValidationError } from "../../domain/errors";
import { validateWithSchema } from "../../http/validation";
import {
  MAX_SCOPE_IDENTIFIER_LENGTH,
  SAFE_SCOPE_IDENTIFIER_REGEX,
  type ProviderStoreScopeInput,
} from "../../types/provider-scope";
import {
  getAuthenticatedUserSession,
  type UserSessionRecord,
} from "../../services/AuthService";

const RunIdSchema = z.string().uuid();
const ScopeIdSchema = z
  .string()
  .min(1)
  .max(MAX_SCOPE_IDENTIFIER_LENGTH)
  .regex(SAFE_SCOPE_IDENTIFIER_REGEX);

export interface AuthorizedProviderScope extends ProviderStoreScopeInput {
  userId: string;
  workspaceId: string;
}

interface SessionClaims {
  userId: string;
  workspaceIds: string[];
  defaultWorkspaceId: string;
}

export async function resolveAuthorizedProviderScope(
  request: Request,
  env: Env,
  correlationId: string,
): Promise<AuthorizedProviderScope> {
  rejectLegacyQueryScope(request, correlationId);
  const runId = parseRequiredRunId(request, correlationId);
  const claims = await loadSessionClaims(request, env, correlationId);

  const requestedUserId = parseOptionalScopeHeader(
    request.headers.get("X-User-Id"),
    "X-User-Id",
    correlationId,
  );
  if (requestedUserId && requestedUserId !== claims.userId) {
    throw new DomainError(
      "AUTH_FAILED",
      "Forbidden: requested user scope does not match authenticated user.",
      403,
      false,
      correlationId,
    );
  }

  const workspaceId = resolveWorkspaceScope(request, claims, correlationId);
  return { runId, userId: claims.userId, workspaceId };
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

function parseRequiredRunId(request: Request, correlationId: string): string {
  const runIdHeader = request.headers.get("X-Run-Id");
  if (!runIdHeader || runIdHeader.trim().length === 0) {
    throw new ValidationError(
      "Missing required X-Run-Id header.",
      "MISSING_RUN_ID",
      correlationId,
    );
  }

  return validateWithSchema<string>(
    runIdHeader.trim(),
    RunIdSchema,
    correlationId,
  );
}

async function loadSessionClaims(
  request: Request,
  env: Env,
  correlationId: string,
): Promise<SessionClaims> {
  try {
    const authenticatedSession = await getAuthenticatedUserSession(
      request,
      env,
    );
    if (!authenticatedSession) {
      throw unauthorized(correlationId);
    }

    return buildSessionClaims(
      authenticatedSession.userId,
      authenticatedSession.session,
      correlationId,
    );
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }

    console.warn(
      `[provider/auth-scope] ${correlationId}: session store read failed`,
      error,
    );
    throw new DomainError(
      "PROVIDER_UNAVAILABLE",
      "Session store is temporarily unavailable. Please retry.",
      503,
      true,
      correlationId,
    );
  }
}

function buildSessionClaims(
  verifiedUserId: string,
  session: UserSessionRecord,
  correlationId: string,
): SessionClaims {
  const workspaceIds = collectWorkspaceIds(session, correlationId);
  const defaultWorkspaceId = workspaceIds[0];
  if (!defaultWorkspaceId) {
    throw new ValidationError(
      "Missing default workspace claim.",
      "VALIDATION_ERROR",
      correlationId,
    );
  }

  return {
    userId: parseRequiredScopeId(
      verifiedUserId,
      "verifiedUserId",
      correlationId,
    ),
    workspaceIds,
    defaultWorkspaceId,
  };
}

function collectWorkspaceIds(
  session: UserSessionRecord,
  correlationId: string,
): string[] {
  const scoped = new Set<string>();
  for (const value of session.workspaceIds ?? []) {
    const parsed = parseOptionalScopeId(
      value,
      "session.workspaceIds",
      correlationId,
    );
    if (parsed) {
      scoped.add(parsed);
    }
  }

  const explicitWorkspace = parseOptionalScopeId(
    session.workspaceId,
    "session.workspaceId",
    correlationId,
  );
  if (explicitWorkspace) {
    scoped.add(explicitWorkspace);
  }

  const defaultWorkspace = parseOptionalScopeId(
    session.defaultWorkspaceId,
    "session.defaultWorkspaceId",
    correlationId,
  );
  if (defaultWorkspace) {
    scoped.add(defaultWorkspace);
  }

  return Array.from(scoped);
}

function resolveWorkspaceScope(
  request: Request,
  claims: SessionClaims,
  correlationId: string,
): string {
  const requestedWorkspace = parseOptionalScopeHeader(
    request.headers.get("X-Workspace-Id"),
    "X-Workspace-Id",
    correlationId,
  );
  if (!requestedWorkspace) {
    return claims.defaultWorkspaceId;
  }

  if (!claims.workspaceIds.includes(requestedWorkspace)) {
    throw new DomainError(
      "AUTH_FAILED",
      "Forbidden: requested workspace scope is not authorized.",
      403,
      false,
      correlationId,
    );
  }

  return requestedWorkspace;
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

function parseRequiredScopeId(
  value: string,
  fieldName: string,
  correlationId: string,
): string {
  const parsed = parseOptionalScopeId(value, fieldName, correlationId);
  if (!parsed) {
    throw new ValidationError(
      `Missing required ${fieldName}.`,
      "VALIDATION_ERROR",
      correlationId,
    );
  }
  return parsed;
}

function unauthorized(correlationId: string): DomainError {
  return new DomainError(
    "AUTH_FAILED",
    "Unauthorized: missing or invalid authentication.",
    401,
    false,
    correlationId,
  );
}
