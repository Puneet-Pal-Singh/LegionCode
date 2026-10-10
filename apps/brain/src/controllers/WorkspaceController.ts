import { z } from "zod";
import { errorResponse, jsonResponse } from "../http/response";
import type { Env } from "../types/ai";
import {
  getAuthenticatedUserSession,
  getGitHubClient,
  isSessionStoreUnavailableError,
} from "../services/AuthService";
import { listHostedWorkspaces, selectHostedWorkspace, SelectWorkspaceRequestSchema } from "../integration/app-server/HostedWorkspaceSelection";

export class WorkspaceController {
  static async listWorkspaces(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const payload = await listHostedWorkspaces(env, auth.userId);
      return jsonResponse(request, env, payload);
    } catch (error) {
      return workspaceErrorResponse(request, env, error);
    }
  }

  static async selectWorkspace(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getGitHubClient(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const body = SelectWorkspaceRequestSchema.parse(await request.json());
      const selection = await selectHostedWorkspace(env, auth.userId, auth.client, body);

      return jsonResponse(request, env, { selection });
    } catch (error) {
      return workspaceErrorResponse(request, env, error);
    }
  }
}

function workspaceErrorResponse(
  request: Request,
  env: Env,
  error: unknown,
): Response {
  if (error instanceof z.ZodError) {
    return errorResponse(request, env, "Invalid workspace request", 400);
  }

  if (isSessionStoreUnavailableError(error)) {
    return errorResponse(request, env, error.message, 503);
  }

  console.error("[workspace/persistence] request failed:", error);
  return errorResponse(request, env, "Failed to persist workspace state", 500);
}
