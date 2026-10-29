import { AppServerOperationError, type ArtifactReviewLookupResult } from "@legioncode/app-server/server";
import type { AppServerComposition } from "@legioncode/app-server/server";
import { EditArtifactReviewError, EditArtifactReviewService } from "../../services/edit-artifacts/EditArtifactReviewService";
import { isSessionStoreUnavailableError } from "../../services/AuthService";
import type { Env } from "../../types/ai";

type HostedEditArtifactReadsService = NonNullable<AppServerComposition["hostedEditArtifactReadsService"]>;

/** Saved review queries composed with the App Server's verified cookie principal. */
export function composeHostedEditArtifactReads(
  env: Env,
  userId: string,
): HostedEditArtifactReadsService {
  return {
    reviewLatest: async (params) => {
      try {
        const { runId, sessionId, ...identity } = params;
        const source = await new EditArtifactReviewService(env).getLatestReviewSource({
          runId,
          sessionId,
          identity,
          userId,
        });
        return lookupResult(source);
      } catch (error) {
        throw mapArtifactReadFailure(error);
      }
    },
    reviewByMessage: async (params) => {
      try {
        const { runId, assistantMessageId, ...identity } = params;
        const source = await new EditArtifactReviewService(env).getReviewSourceByMessage({
          runId,
          assistantMessageId,
          identity,
          userId,
        });
        return lookupResult(source);
      } catch (error) {
        throw mapArtifactReadFailure(error);
      }
    },
    diff: async (params) => {
      try {
        const { artifactId, path, ...identity } = params;
        return await new EditArtifactReviewService(env).getArtifactDiff({
          artifactId,
          path,
          identity,
          userId,
        });
      } catch (error) {
        throw mapArtifactReadFailure(error);
      }
    },
  };
}

function lookupResult(source: Awaited<ReturnType<EditArtifactReviewService["getLatestReviewSource"]>>): ArtifactReviewLookupResult {
  return source ? { source, status: 200 } : { source: null, status: 204 };
}

function mapArtifactReadFailure(error: unknown): AppServerOperationError {
  if (error instanceof AppServerOperationError) return error;
  if (error instanceof EditArtifactReviewError) {
    const status = error.code === "ARTIFACT_UNAUTHORIZED"
      ? 403
      : error.code === "ARTIFACT_PATCH_MISSING" ? 404 : 409;
    const code = status === 403 ? "forbidden" : status === 404 ? "not_found" : "conflict";
    return new AppServerOperationError(status, code, error.message, error.code, false);
  }
  if (isSessionStoreUnavailableError(error)) {
    return new AppServerOperationError(503, "server_unavailable", error.message, "API_ERROR", true);
  }
  console.error("[edit-artifacts/review] App Server request failed:", error);
  return new AppServerOperationError(500, "server_unavailable", "Failed to load edit artifact", "API_ERROR", true);
}
