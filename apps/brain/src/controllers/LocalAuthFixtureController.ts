import { encryptToken } from "@shadowbox/github-bridge";
import { createGitHubOAuthSession, createSessionCookie } from "../services/AuthService";
import { withWorkspaceRepository } from "../services/workspaces/WorkspacePersistenceFactory";
import { errorResponse, jsonResponse } from "../http/response";
import type { Env } from "../types/ai";

const FIXTURE_FLAG = "1";
const FIXTURE_HEADER = "X-Shadowbox-Local-Auth";
const FIXTURE_HEADER_VALUE = "1";
const FIXTURE_LOGIN = "shadowbox-local-test";
const FIXTURE_PROVIDER_ACCOUNT_ID = "shadowbox-local-playwright";
const FIXTURE_ACCESS_TOKEN = "shadowbox-local-test-access-token";

export class LocalAuthFixtureController {
  static async handleCreateSession(
    request: Request,
    env: Env,
  ): Promise<Response> {
    if (!isEnabledForLoopbackRequest(request, env)) {
      return errorResponse(request, env, "Not found", 404);
    }

    if (!env.GITHUB_TOKEN_ENCRYPTION_KEY) {
      return unavailableResponse(request, env);
    }

    try {
      const now = new Date().toISOString();
      const encryptedToken = await encryptToken(
        FIXTURE_ACCESS_TOKEN,
        env.GITHUB_TOKEN_ENCRYPTION_KEY,
      );
      const createdSession = await createGitHubOAuthSession(env, {
        providerAccountId: FIXTURE_PROVIDER_ACCOUNT_ID,
        login: FIXTURE_LOGIN,
        avatarUrl: "https://avatars.example.test/shadowbox-local-test.png",
        email: "shadowbox-local-test@example.test",
        displayName: "Shadowbox Local Test",
        accessToken: FIXTURE_ACCESS_TOKEN,
        encryptedToken,
        scopes: ["repo", "read:user", "user:email"],
        tokenExpiresInSeconds: null,
      });

      await withWorkspaceRepository(env, (repository) =>
        repository.selectWorkspace({
          userId: createdSession.session.userId,
          repository: {
            provider: "github",
            owner: "shadowbox",
            name: "local-concurrency-fixture",
            fullName: "shadowbox/local-concurrency-fixture",
            repoUrl: "https://github.com/shadowbox/local-concurrency-fixture",
            defaultBranch: "main",
            providerRepoId: "shadowbox-local-concurrency-fixture",
            now,
          },
          workspaceName: "Shadowbox",
          selectedBranch: "main",
          now,
        }),
      );

      return jsonResponse(
        request,
        env,
        { authenticated: true, fixture: "local", workspaceName: "Shadowbox" },
        { customHeaders: { "Set-Cookie": createSessionCookie(createdSession.sessionToken) } },
      );
    } catch {
      return unavailableResponse(request, env);
    }
  }
}

function isEnabledForLoopbackRequest(request: Request, env: Env): boolean {
  if (
    env.SHADOWBOX_LOCAL_AUTH_FIXTURE !== FIXTURE_FLAG ||
    env.ENVIRONMENT === "production" ||
    env.NODE_ENV === "production"
  ) {
    return false;
  }

  if (request.headers.get(FIXTURE_HEADER) !== FIXTURE_HEADER_VALUE) {
    return false;
  }

  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function unavailableResponse(request: Request, env: Env): Response {
  return errorResponse(
    request,
    env,
    "Local auth fixture unavailable",
    503,
    "LOCAL_AUTH_FIXTURE_UNAVAILABLE",
  );
}
