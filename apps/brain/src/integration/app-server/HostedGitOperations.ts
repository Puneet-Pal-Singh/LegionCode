import {
  AppServerOperationError,
  type AppServerComposition,
} from "@legioncode/app-server/server";
import type { AppServerRequest } from "@legioncode/app-server/protocol";
import { isDomainError, mapDomainErrorToHttp } from "../../domain/errors";
import { resolveOwnedCheckoutExecution, type OwnedCheckoutExecution } from "./OwnedCheckoutExecution";
import {
  GitExecutionError,
  GitExecutionService,
} from "../../services/git/GitExecutionService";
import type { Env } from "../../types/ai";

type GitRequest = Extract<AppServerRequest, { method: `git/${string}` }>;
type GitParams = GitRequest["params"];

export function composeHostedGitOperations(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedGitOperationsService"]> {
  return {
    status: async (params) => await run("status", params, (operations) => operations.status(params)),
    diff: async (params) => await run("diff", params, (operations) => operations.diff(params)),
    stage: async (params) => await run("stage", params, (operations) => operations.stage(params)),
    commit: async (params) => await run("commit", params, (operations) => operations.commit(request, params)),
    branch: async (params) => await run("branch", params, (operations) => operations.branch(params)),
    push: async (params) => await run("push", params, (operations) => operations.push(request, params)),
    pullRequest: async (params) => await run("pullRequest", params, (operations) => operations.pullRequest(request, params)),
  };

  async function run<T>(
    operation: string,
    params: GitParams,
    execute: (operations: GitExecutionService) => Promise<T>,
  ): Promise<T> {
    let execution: OwnedCheckoutExecution;
    try {
      execution = await resolveOwnedCheckoutExecution(request, env, userId, params);
    } catch (error) {
      throw mapOwnedGitError(error, operation);
    }
    try {
      return await execute(new GitExecutionService(env, execution));
    } catch (error) {
      throw mapOwnedGitError(error, operation);
    }
  }
}


function mapOwnedGitError(error: unknown, operation: string): AppServerOperationError {
  if (error instanceof AppServerOperationError) return error;
  if (error instanceof GitExecutionError) {
    return new AppServerOperationError(
      error.status,
      appServerCategory(error.status),
      error.message,
      error.code,
      error.retryable,
      undefined,
      error.metadata ? { ...error.metadata } : undefined,
    );
  }
  if (isDomainError(error)) {
    const mapped = mapDomainErrorToHttp(error);
    return new AppServerOperationError(
      mapped.status,
      appServerCategory(mapped.status),
      mapped.message,
      mapped.code,
      error.retryable,
      error.correlationId,
      mapped.metadata,
    );
  }
  return new AppServerOperationError(
    503,
    "server_unavailable",
    `Git ${operation} is temporarily unavailable`,
    "GIT_OPERATION_UNAVAILABLE",
    true,
  );
}

function appServerCategory(status: number): "invalid_request" | "unauthorized" | "not_found" | "conflict" | "server_unavailable" {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return "server_unavailable";
}
