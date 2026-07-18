// apps/brain/src/index.ts
import { ChatController } from "./controllers/ChatController";
import { AuthController } from "./controllers/AuthController";
import { GitHubController } from "./controllers/GitHubController";
import { GitController } from "./controllers/GitController";
import { RunController } from "./controllers/RunController";
import { ProviderController } from "./controllers/ProviderController";
import { RuntimeController } from "./controllers/RuntimeController";
import { RuntimeEventController } from "./controllers/RuntimeEventController";
import { WorkspaceController } from "./controllers/WorkspaceController";
import { TranscriptController } from "./controllers/TranscriptController";
import { EditArtifactController } from "./controllers/EditArtifactController";
import { LifecycleController } from "./controllers/LifecycleController";
import { TurnController } from "./controllers/TurnController";
import { HookDefinitionController } from "./controllers/HookDefinitionController";
import { handleOptions, getCorsHeaders } from "./lib/cors";
import { Env } from "./types/ai";
import { RunEngineRuntime } from "./runtime/RunEngineRuntime";
import { RunAdmissionLimiter } from "./runtime/RunAdmissionLimiter";
import { getBrainRuntimeHeaders } from "./core/observability/runtime";
import { EditArtifactRetentionService } from "./services/edit-artifacts/EditArtifactRetentionService";
import {
  getOrCreateCorrelationId,
  reportBrainError,
  withCorrelationId,
  withObservabilityHeaders,
} from "./core/observability/BrainErrorReporter";

export { RunEngineRuntime, RunAdmissionLimiter };

/**
 * Route configuration type with HTTP method support
 */
interface RouteConfig {
  pattern: RegExp;
  method: string;
  handler: (
    request: Request,
    env: Env,
    context?: ExecutionContext,
  ) => Promise<Response>;
}

/**
 * Router class - Single Responsibility: Route matching only
 * Follows Open/Closed: New routes can be added without modifying existing code
 * Now includes HTTP method matching for RESTful API design
 */
class Router {
  private routes: RouteConfig[] = [];

  add(
    pattern: RegExp,
    handler: RouteConfig["handler"],
    method: string = "GET",
  ): void {
    this.routes.push({ pattern, method: method.toUpperCase(), handler });
  }

  async match(
    request: Request,
    env: Env,
    context?: ExecutionContext,
  ): Promise<Response | null> {
    const url = new URL(request.url);
    const requestMethod = request.method.toUpperCase();

    for (const route of this.routes) {
      if (route.pattern.test(url.pathname) && route.method === requestMethod) {
        return await route.handler(request, env, context);
      }
    }

    return null;
  }
}

/**
 * Create and configure router with all application routes
 * Separates route configuration from request handling logic
 */
function createRouter(): Router {
  const router = new Router();

  // Chat routes
  router.add(
    /^\/api\/chat(?:\/.*)?$/,
    ChatController.handleLegacyRoute,
    "POST",
  );
  router.add(/^\/api\/chat\/history$/, TranscriptController.getHistory, "GET");
  router.add(/\/chat/, ChatController.handle, "POST");
  router.add(/^\/turn\/start$/, TurnController.start, "POST");
  router.add(
    /^\/api\/debug\/runtime$/,
    RuntimeController.getRuntimeDebug,
    "GET",
  );
  router.add(
    /^\/internal\/runtime\/events$/,
    (request, env) =>
      RuntimeEventController.acceptInternalRuntimeEvent(request, env),
    "POST",
  );

  // Auth routes - OAuth flow
  router.add(/\/auth\/github\/login/, AuthController.handleLogin);
  router.add(/\/auth\/github\/reauthorize/, AuthController.handleLogin);
  router.add(/\/auth\/github\/callback/, AuthController.handleCallback);
  router.add(/\/auth\/session/, AuthController.handleGetSession);
  router.add(/\/auth\/logout/, AuthController.handleLogout);

  // GitHub API routes
  router.add(/\/api\/github\/repos/, GitHubController.listRepositories);
  router.add(/\/api\/github\/branches/, GitHubController.listBranches);
  router.add(/\/api\/github\/contents/, GitHubController.getContents);
  router.add(/\/api\/github\/tree/, GitHubController.getTree);
  router.add(/\/api\/github\/pulls$/, GitHubController.listPullRequests, "GET");
  router.add(/\/api\/github\/pulls\//, GitHubController.getPullRequest, "GET");
  router.add(
    /\/api\/github\/pulls$/,
    GitHubController.createPullRequest,
    "POST",
  );
  router.add(/^\/api\/workspaces$/, WorkspaceController.listWorkspaces, "GET");
  router.add(
    /^\/api\/workspaces\/selection$/,
    WorkspaceController.selectWorkspace,
    "POST",
  );
  router.add(
    /^\/api\/workspaces\/[^/]+\/hooks$/,
    HookDefinitionController.list,
    "GET",
  );
  router.add(
    /^\/api\/workspaces\/[^/]+\/hooks\/[^/]+$/,
    HookDefinitionController.upsert,
    "PUT",
  );
  router.add(
    /^\/api\/workspaces\/[^/]+\/hooks\/[^/]+$/,
    HookDefinitionController.delete,
    "DELETE",
  );
  router.add(/^\/api\/sessions$/, TranscriptController.listSessions, "GET");
  router.add(/^\/api\/sessions$/, TranscriptController.createSession, "POST");
  router.add(
    /^\/api\/sessions\/archived$/,
    TranscriptController.listArchivedSessions,
    "GET",
  );
  router.add(
    /^\/api\/sessions\/[^/]+\/title$/,
    TranscriptController.renameSessionTitle,
    "PATCH",
  );
  router.add(
    /^\/api\/sessions\/[^/]+\/pin$/,
    TranscriptController.pinSession,
    "POST",
  );
  router.add(
    /^\/api\/sessions\/[^/]+\/unpin$/,
    TranscriptController.unpinSession,
    "POST",
  );
  router.add(
    /^\/api\/sessions\/[^/]+\/archive$/,
    TranscriptController.archiveSession,
    "POST",
  );
  router.add(
    /^\/api\/sessions\/[^/]+\/unarchive$/,
    TranscriptController.unarchiveSession,
    "POST",
  );

  // Git local routes (for sidebar)
  router.add(/\/api\/git\/status/, GitController.getStatus);
  router.add(/\/api\/git\/diff/, GitController.getDiff);
  router.add(/\/api\/git\/bootstrap/, GitController.bootstrap, "POST");
  router.add(/\/api\/git\/stage/, GitController.stageFiles, "POST");
  router.add(/\/api\/git\/commit/, GitController.commit, "POST");
  router.add(/\/api\/git\/branch/, GitController.createBranch, "POST");
  router.add(/\/api\/git\/push/, GitController.push, "POST");
  router.add(
    /\/api\/git\/pull-request/,
    GitController.createPullRequest,
    "POST",
  );
  router.add(/^\/api\/run\/summary$/, RunController.getSummary, "GET");
  router.add(
    /^\/api\/run\/events\/stream$/,
    RunController.getEventsStream,
    "GET",
  );
  router.add(/^\/api\/run\/events$/, RunController.getEvents, "GET");
  router.add(/^\/api\/run\/activity$/, RunController.getActivity, "GET");
  router.add(/^\/api\/run\/interrupt$/, RunController.interrupt, "POST");
  router.add(/^\/api\/run\/approval$/, RunController.approve, "POST");
  router.add(
    /^\/turns\/[^/]+\/lifecycle-events$/,
    LifecycleController.getEvents,
    "GET",
  );
  router.add(
    /^\/turns\/[^/]+\/lifecycle-events\/stream$/,
    LifecycleController.getEventsStream,
    "GET",
  );
  router.add(/^\/turns\/[^/]+\/diff$/, LifecycleController.getTurnDiff, "GET");
  router.add(
    /^\/turns\/[^/]+\/approvals\/[^/]+$/,
    LifecycleController.submitApproval,
    "POST",
  );
  router.add(
    /^\/api\/edit-artifacts\/latest$/,
    EditArtifactController.getLatest,
    "GET",
  );
  router.add(
    /^\/api\/edit-artifacts\/by-message$/,
    EditArtifactController.getByMessage,
    "GET",
  );
  router.add(
    /^\/api\/edit-artifacts\/[^/]+\/files$/,
    EditArtifactController.getFiles,
    "GET",
  );
  router.add(
    /^\/api\/edit-artifacts\/[^/]+\/diff$/,
    EditArtifactController.getDiff,
    "GET",
  );

  // BYOK v3 routes
  router.add(
    /^\/api\/byok\/providers\/[^/]+\/models$/,
    ProviderController.byokProviderModels,
    "GET",
  );
  router.add(
    /^\/api\/byok\/providers\/[^/]+\/models\/refresh$/,
    ProviderController.byokRefreshProviderModels,
    "POST",
  );
  router.add(
    /^\/api\/byok\/providers$/,
    ProviderController.byokProviders,
    "GET",
  );
  router.add(
    /^\/api\/byok\/credentials$/,
    ProviderController.byokCredentials,
    "GET",
  );
  router.add(
    /^\/api\/byok\/credentials$/,
    ProviderController.byokConnectCredential,
    "POST",
  );
  router.add(
    /^\/api\/byok\/credentials\/[^/]+$/,
    ProviderController.byokUpdateCredential,
    "PATCH",
  );
  router.add(
    /^\/api\/byok\/credentials\/[^/]+$/,
    ProviderController.byokDisconnectCredential,
    "DELETE",
  );
  router.add(
    /^\/api\/byok\/credentials\/[^/]+\/validate$/,
    ProviderController.byokValidateCredential,
    "POST",
  );
  router.add(
    /^\/api\/byok\/preferences$/,
    ProviderController.byokGetPreferencesV3,
    "GET",
  );
  router.add(
    /^\/api\/byok\/preferences$/,
    ProviderController.byokPreferencesV3,
    "PATCH",
  );
  router.add(/^\/api\/byok\/resolve$/, ProviderController.byokResolve, "POST");

  return router;
}

/**
 * Main request handler
 * Delegates to controllers - follows Dependency Inversion Principle
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const correlationId = getOrCreateCorrelationId(request);
    const correlatedRequest = withCorrelationId(request, correlationId);
    const optionsResponse = handleOptions(correlatedRequest, env);
    if (optionsResponse) return optionsResponse;

    const router = createRouter();

    try {
      const response = await router.match(correlatedRequest, env, context);

      if (response) {
        return withObservabilityHeaders(response, correlationId);
      }

      return withObservabilityHeaders(
        new Response(
          JSON.stringify({
            error: "Not Found",
            path: new URL(request.url).pathname,
          }),
          {
            status: 404,
            headers: {
              ...getCorsHeaders(correlatedRequest, env),
              ...getBrainRuntimeHeaders(env),
              "Content-Type": "application/json",
            },
          },
        ),
        correlationId,
      );
    } catch (error: unknown) {
      reportBrainError(env, {
        request: correlatedRequest,
        operation: "http.router.dispatch",
        error,
      });

      return withObservabilityHeaders(
        new Response(
          JSON.stringify({
            error: "Internal Server Error",
            code: "HTTP_REQUEST_FAILED",
            correlationId,
          }),
          {
            status: 500,
            headers: {
              ...getCorsHeaders(correlatedRequest, env),
              ...getBrainRuntimeHeaders(env),
              "Content-Type": "application/json",
            },
          },
        ),
        correlationId,
      );
    }
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const result = await new EditArtifactRetentionService(
      env,
    ).expireArtifacts();
    console.log(
      `[edit-artifacts/retention] expired=${result.expiredCount} repaired_pending=${result.repairedPendingCount}`,
    );
  },
};
