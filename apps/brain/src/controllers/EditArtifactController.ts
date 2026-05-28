import { z } from "zod";
import { errorResponse, jsonResponse } from "../http/response";
import type { Env } from "../types/ai";
import {
  getAuthenticatedUserSession,
  isSessionStoreUnavailableError,
} from "../services/AuthService";
import {
  EditArtifactReviewError,
  type EditArtifactReviewErrorCode,
  EditArtifactReviewService,
} from "../services/edit-artifacts/EditArtifactReviewService";

const LatestArtifactQuerySchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});

const MessageArtifactQuerySchema = z.object({
  runId: z.string().min(1),
  assistantMessageId: z.string().min(1),
});

const ArtifactPathParamsSchema = z.object({
  artifactId: z.string().uuid(),
});

const ArtifactDiffQuerySchema = z.object({
  path: z.string().min(1),
});

export class EditArtifactController {
  static async getLatest(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await resolveOptionalAuth(request, env);
      if (!auth.canReadRunScopedArtifacts) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const query = LatestArtifactQuerySchema.parse(readQuery(request));
      const source = await new EditArtifactReviewService(
        env,
      ).getLatestReviewSource({
        ...query,
        userId: auth.userId,
      });

      if (!source) {
        return artifactNotFoundResponse(request, env);
      }
      return jsonResponse(request, env, source);
    } catch (error) {
      return editArtifactErrorResponse(request, env, error);
    }
  }

  static async getByMessage(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await resolveOptionalAuth(request, env);
      if (!auth.canReadRunScopedArtifacts) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const query = MessageArtifactQuerySchema.parse(readQuery(request));
      const source = await new EditArtifactReviewService(
        env,
      ).getReviewSourceByMessage({
        ...query,
        userId: auth.userId,
      });

      if (!source) {
        return artifactNotFoundResponse(request, env);
      }
      return jsonResponse(request, env, source);
    } catch (error) {
      return editArtifactErrorResponse(request, env, error);
    }
  }

  static async getFiles(request: Request, env: Env): Promise<Response> {
    try {
      const userId = await requireUserId(request, env);
      if (!userId) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const params = ArtifactPathParamsSchema.parse(readArtifactParams(request));
      const files = await new EditArtifactReviewService(env).getArtifactFiles({
        artifactId: params.artifactId,
        userId,
      });
      return jsonResponse(request, env, { files });
    } catch (error) {
      return editArtifactErrorResponse(request, env, error);
    }
  }

  static async getDiff(request: Request, env: Env): Promise<Response> {
    try {
      const userId = await requireUserId(request, env);
      if (!userId) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const params = ArtifactPathParamsSchema.parse(readArtifactParams(request));
      const query = ArtifactDiffQuerySchema.parse(readQuery(request));
      const diff = await new EditArtifactReviewService(env).getArtifactDiff({
        artifactId: params.artifactId,
        userId,
        path: query.path,
      });
      return jsonResponse(request, env, diff);
    } catch (error) {
      return editArtifactErrorResponse(request, env, error);
    }
  }
}

async function resolveOptionalAuth(
  request: Request,
  env: Env,
): Promise<{ userId?: string; canReadRunScopedArtifacts: boolean }> {
  const auth = await getAuthenticatedUserSession(request, env);
  if (auth) {
    return { userId: auth.userId, canReadRunScopedArtifacts: true };
  }
  return {
    canReadRunScopedArtifacts:
      env.NODE_ENV === "development" || env.NODE_ENV === "test",
  };
}

async function requireUserId(
  request: Request,
  env: Env,
): Promise<string | null> {
  const auth = await getAuthenticatedUserSession(request, env);
  return auth?.userId ?? null;
}

function readQuery(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

function readArtifactParams(request: Request): { artifactId: string | null } {
  const match = new URL(request.url).pathname.match(
    /^\/api\/edit-artifacts\/([^/]+)\/(?:files|diff)$/,
  );
  if (!match?.[1]) {
    return { artifactId: null };
  }
  try {
    return { artifactId: decodeURIComponent(match[1]) };
  } catch {
    return { artifactId: null };
  }
}

function artifactNotFoundResponse(request: Request, env: Env): Response {
  return errorResponse(
    request,
    env,
    "No saved edit artifact found.",
    404,
    "ARTIFACT_NOT_FOUND",
  );
}

function editArtifactErrorResponse(
  request: Request,
  env: Env,
  error: unknown,
): Response {
  if (error instanceof z.ZodError) {
    return errorResponse(request, env, "Invalid edit artifact request", 400);
  }

  if (error instanceof EditArtifactReviewError) {
    return editArtifactReviewErrorResponse(request, env, error);
  }

  if (isSessionStoreUnavailableError(error)) {
    return errorResponse(request, env, error.message, 503);
  }

  console.error("[edit-artifacts/review] request failed:", error);
  return errorResponse(request, env, "Failed to load edit artifact", 500);
}

function editArtifactReviewErrorResponse(
  request: Request,
  env: Env,
  error: EditArtifactReviewError,
): Response {
  const statusByCode: Record<EditArtifactReviewErrorCode, number> = {
    ARTIFACT_PATCH_MISSING: 404,
    ARTIFACT_PATCH_CORRUPT: 409,
    ARTIFACT_UNAUTHORIZED: 403,
  };
  return errorResponse(
    request,
    env,
    error.message,
    statusByCode[error.code],
    error.code,
  );
}
