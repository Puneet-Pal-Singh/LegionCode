import { resolveHostedResourceScope } from "./HostedResourceScope";
import { RunIdSchema, type RunId } from "@repo/platform-protocol";
import { AppServerProviderOperationError } from "@legioncode/app-server/server";
import {
  type AuthorizedProviderScope,
} from "../../controllers/provider/ProviderAuthScopeService";
import {
  isDomainError,
  toNormalizedProviderError,
} from "../../domain/errors";
import type { Env } from "../../types/ai";
import { validateWithSchema } from "../../http/validation";

/** Bind hosted provider operations to an owned run or the authenticated workspace for setup. */
export function createHostedProviderOperation(
  request: Request,
  env: Env,
  userId: string,
) {
  return async <T>(
    runId: string | undefined,
    action: (
      scope: AuthorizedProviderScope,
      correlationId: string,
    ) => Promise<T>,
  ): Promise<T> => {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveHostedResourceScope(
        request,
        env,
        userId,
        correlationId,
        runId === undefined
          ? undefined
          : validateWithSchema<RunId>(runId, RunIdSchema, correlationId),
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
