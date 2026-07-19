import {
  HookDefinitionSchema,
  HookHandlerIdSchema,
  type HookHandlerId,
} from "@repo/hook-protocol";
import { z } from "zod";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
} from "../http/response";
import type { Env } from "../types/ai";
import {
  getAuthenticatedUserSession,
  isSessionStoreUnavailableError,
} from "../services/AuthService";
import {
  HookDefinitionWriteConflictError,
  type HookDefinitionScope,
} from "../services/hooks/HookDefinitionRepository";
import { withHookDefinitionRepository } from "../services/hooks/HookDefinitionPersistenceFactory";
import { withWorkspaceRepository } from "../services/workspaces/WorkspacePersistenceFactory";

const WorkspaceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export class HookDefinitionController {
  static async list(request: Request, env: Env): Promise<Response> {
    try {
      const context = await readAuthorizedContext(request, env, "collection");
      if (context instanceof Response) {
        return context;
      }

      const hooks = await withHookDefinitionRepository(
        env,
        async (repository) => await repository.list(context.scope),
      );
      return jsonResponse(request, env, { hooks });
    } catch (error) {
      return hookDefinitionErrorResponse(request, env, error);
    }
  }

  static async upsert(request: Request, env: Env): Promise<Response> {
    try {
      const context = await readAuthorizedContext(request, env, "item");
      if (context instanceof Response) {
        return context;
      }

      const definition = HookDefinitionSchema.parse(await request.json());
      if (definition.handlerId !== context.handlerId) {
        return errorResponse(
          request,
          env,
          "Hook handler does not match the request path",
          400,
          "HOOK_HANDLER_ID_MISMATCH",
        );
      }
      if (definition.source !== "user") {
        return errorResponse(
          request,
          env,
          "Only user hook definitions can be configured through this API",
          403,
          "HOOK_SOURCE_NOT_USER_MANAGED",
        );
      }

      const hook = await withHookDefinitionRepository(
        env,
        async (repository) =>
          await repository.upsert(
            context.scope,
            definition,
            new Date().toISOString(),
          ),
      );
      return jsonResponse(request, env, { hook });
    } catch (error) {
      return hookDefinitionErrorResponse(request, env, error);
    }
  }

  static async delete(request: Request, env: Env): Promise<Response> {
    try {
      const context = await readAuthorizedContext(request, env, "item");
      if (context instanceof Response) {
        return context;
      }

      const deleted = await withHookDefinitionRepository(
        env,
        async (repository) =>
          await repository.deleteUserDefinition(
            context.scope,
            context.handlerId,
          ),
      );
      if (!deleted) {
        return errorResponse(request, env, "Hook not found", 404);
      }
      return noContentResponse(request, env);
    } catch (error) {
      return hookDefinitionErrorResponse(request, env, error);
    }
  }
}

type AuthorizedCollectionContext = {
  scope: HookDefinitionScope;
};

type AuthorizedItemContext = AuthorizedCollectionContext & {
  handlerId: HookHandlerId;
};

async function readAuthorizedContext(
  request: Request,
  env: Env,
  routeKind: "collection",
): Promise<AuthorizedCollectionContext | Response>;
async function readAuthorizedContext(
  request: Request,
  env: Env,
  routeKind: "item",
): Promise<AuthorizedItemContext | Response>;
async function readAuthorizedContext(
  request: Request,
  env: Env,
  routeKind: "collection" | "item",
): Promise<AuthorizedCollectionContext | AuthorizedItemContext | Response> {
  const auth = await getAuthenticatedUserSession(request, env);
  if (!auth) {
    return errorResponse(request, env, "Unauthorized", 401);
  }

  const route = parseHookDefinitionRoute(new URL(request.url).pathname);
  if (!route || (routeKind === "item" && !route.handlerId)) {
    return errorResponse(request, env, "Invalid hook configuration path", 400);
  }

  const ownsWorkspace = await withWorkspaceRepository(env, async (repository) =>
    (await repository.listWorkspaces(auth.userId)).some(
      (entry) => entry.workspace.id === route.workspaceId,
    ),
  );
  if (!ownsWorkspace) {
    return errorResponse(request, env, "Workspace not found", 404);
  }

  const scope = {
    userId: auth.userId,
    workspaceId: route.workspaceId,
  };
  if (routeKind === "item") {
    return { scope, handlerId: route.handlerId as HookHandlerId };
  }
  return { scope };
}

function parseHookDefinitionRoute(pathname: string): {
  workspaceId: string;
  handlerId?: HookHandlerId;
} | null {
  const match = pathname.match(
    /^\/api\/workspaces\/([^/]+)\/hooks(?:\/([^/]+))?$/,
  );
  if (!match?.[1]) {
    return null;
  }

  try {
    const workspaceId = WorkspaceIdSchema.parse(decodeURIComponent(match[1]));
    const handlerId = match[2]
      ? HookHandlerIdSchema.parse(decodeURIComponent(match[2]))
      : undefined;
    return handlerId ? { workspaceId, handlerId } : { workspaceId };
  } catch {
    return null;
  }
}

function hookDefinitionErrorResponse(
  request: Request,
  env: Env,
  error: unknown,
): Response {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return errorResponse(
      request,
      env,
      "Invalid hook definition request",
      400,
      "INVALID_HOOK_DEFINITION",
    );
  }
  if (isSessionStoreUnavailableError(error)) {
    return errorResponse(request, env, error.message, 503);
  }
  if (error instanceof HookDefinitionWriteConflictError) {
    return errorResponse(
      request,
      env,
      "Hook configuration changed before it could be saved",
      409,
      error.code,
    );
  }

  console.error("[hooks/persistence] request failed:", error);
  return errorResponse(
    request,
    env,
    "Failed to persist hook configuration",
    500,
  );
}
