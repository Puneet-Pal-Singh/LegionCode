import { z } from "zod";
import { errorResponse, jsonResponse } from "../http/response";
import type { Env } from "../types/ai";
import {
  getAuthenticatedUserSession,
  getGitHubClient,
  isSessionStoreUnavailableError,
} from "../services/AuthService";
import { WorkspaceSelectionService } from "../services/workspaces/WorkspaceSelectionService";
import { withWorkspaceRepository } from "../services/workspaces/WorkspacePersistenceFactory";

const SelectWorkspaceRequestSchema = z.object({
  repository: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
  }),
  selectedBranch: z.string().min(1),
});

export class WorkspaceController {
  static async listWorkspaces(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const payload = await withWorkspaceRepository(env, (repository) =>
        new WorkspaceSelectionService(repository).getWorkspaceList(auth.userId),
      );
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
      const repository = await auth.client.getRepository(
        body.repository.owner,
        body.repository.name,
      );
      const selection = await withWorkspaceRepository(env, (workspaceRepo) =>
        new WorkspaceSelectionService(workspaceRepo).selectGitHubWorkspace({
          userId: auth.userId,
          repository,
          selectedBranch: body.selectedBranch,
        }),
      );

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
