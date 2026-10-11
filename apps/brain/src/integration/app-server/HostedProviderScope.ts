import { RunIdSchema } from "@repo/platform-protocol";
import { AppServerProviderOperationError } from "@legioncode/app-server/server";
import { resolveAuthorizedProviderScope } from "../../controllers/provider/ProviderAuthScopeService";
import {
  DomainError,
  isDomainError,
  toNormalizedProviderError,
} from "../../domain/errors";
import type { Env } from "../../types/ai";

/** Shared cookie/run/workspace authorization for hosted provider operations. */
export function createHostedProviderOperation(
  request: Request,
  env: Env,
  userId: string,
) {
  return async <T>(
    runId: string,
    action: (
      scope: Awaited<ReturnType<typeof resolveAuthorizedProviderScope>>,
      correlationId: string,
    ) => Promise<T>,
  ): Promise<T> => {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        request,
        env,
        correlationId,
        RunIdSchema.parse(runId),
      );
      if (scope.userId !== userId)
        throw new DomainError(
          "AUTH_FAILED",
          "Unauthorized",
          401,
          false,
          correlationId,
        );
      return await action(scope, correlationId);
    } catch (error) {
      throw new AppServerProviderOperationError(
        isDomainError(error) ? error.status : 500,
        toNormalizedProviderError(error, correlationId),
      );
    }
  };
}
