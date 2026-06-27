/**
 * AuthController
 *
 * Handles GitHub OAuth authentication flow
 * Part of the Control Plane (Brain) - manages identity and tokens
 * Follows Single Responsibility: Only handles OAuth flow
 */

import { Env } from "../types/ai";
import {
  generateAuthUrl,
  exchangeCodeForToken,
  verifyState,
  generateState,
  fetchGitHubUser,
  encryptToken,
  type OAuthConfig,
} from "@shadowbox/github-bridge";
import {
  createExpiredSessionCookie,
  createGitHubOAuthSession,
  createSessionCookie,
  getAuthenticatedUserSession,
  isSessionStoreUnavailableError,
  revokeAuthenticatedSession,
} from "../services/AuthService";
import { parseGitHubScopeList } from "../services/github/GitHubScopeMatrix";
import {
  readCommitIdentityStateForUser,
  resolveGitHubProfileIdentityFromOAuth,
} from "../services/git/GitCommitIdentityService";
import { errorResponse, jsonResponse } from "../http/response";
import { getCorsHeaders } from "../lib/cors";
import {
  getPrivateAlphaWaitlistUrl,
  hasPrivateAlphaAccess,
} from "../services/auth/PrivateAlphaAccessPolicy";

interface AuthSession {
  state: string;
  createdAt: number;
}

const SESSION_TTL = 10 * 60 * 1000; // 10 minutes

export class AuthController {
  /**
   * Initiate GitHub OAuth flow
   * GET /auth/github/login
   */
  static async handleLogin(request: Request, env: Env): Promise<Response> {
    try {
      console.log("[auth/login] initiating OAuth login");

      // Validate required environment variables
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        console.error(
          "[auth/login] missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET",
        );
        return errorResponse(
          request,
          env,
          "Server configuration error: Missing GitHub OAuth credentials",
          500,
        );
      }

      if (!env.GITHUB_REDIRECT_URI) {
        console.error("[auth/login] missing GITHUB_REDIRECT_URI");
        return errorResponse(
          request,
          env,
          "Server configuration error: Missing redirect URI",
          500,
        );
      }

      const state = generateState();
      console.log("[auth/login] generated OAuth state");

      // Store state in KV with expiration
      const session: AuthSession = {
        state,
        createdAt: Date.now(),
      };

      await env.SESSIONS.put(
        `oauth_state:${state}`,
        JSON.stringify(session),
        { expirationTtl: 600 }, // 10 minutes
      );
      console.log("[auth/login] OAuth state stored in KV");

      const config: OAuthConfig = {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        redirectUri: env.GITHUB_REDIRECT_URI,
        scopes: ["repo", "read:user", "user:email"],
      };

      const authUrl = generateAuthUrl(config, state);
      console.log("[auth/login] redirecting to GitHub");

      return new Response(null, {
        status: 302,
        headers: {
          Location: authUrl,
          ...getCorsHeaders(request, env),
        },
      });
    } catch (error) {
      console.error("[auth/login] error:", error);
      return errorResponse(
        request,
        env,
        "Failed to initiate authentication",
        500,
      );
    }
  }

  /**
   * Handle GitHub OAuth callback
   * GET /auth/github/callback?code=xxx&state=xxx
   */
  static async handleCallback(request: Request, env: Env): Promise<Response> {
    try {
      console.log("[auth/callback] OAuth callback received");

      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");

      // Handle OAuth errors from GitHub
      if (oauthError) {
        console.error("[auth/callback] GitHub OAuth error:", oauthError);
        return errorResponse(
          request,
          env,
          `GitHub authentication failed: ${oauthError}`,
          400,
        );
      }

      if (!code || !state) {
        return errorResponse(
          request,
          env,
          "Missing code or state parameter",
          400,
        );
      }

      // Verify state to prevent CSRF
      const sessionData = await env.SESSIONS.get(`oauth_state:${state}`);
      if (!sessionData) {
        console.error("[auth/callback] state not found in KV store");
        return errorResponse(request, env, "Invalid or expired session", 400);
      }

      let session: AuthSession;
      try {
        session = JSON.parse(sessionData) as AuthSession;
      } catch (parseError) {
        console.warn(
          "[auth/callback] corrupted OAuth state in KV store",
          parseError instanceof Error ? parseError.message : parseError,
        );
        return errorResponse(request, env, "Invalid or expired session", 400);
      }

      // Check session expiration
      if (Date.now() - session.createdAt > SESSION_TTL) {
        await env.SESSIONS.delete(`oauth_state:${state}`);
        return errorResponse(request, env, "Session expired", 400);
      }

      // Verify state matches
      if (!verifyState(state, session.state)) {
        return errorResponse(request, env, "Invalid state parameter", 400);
      }

      // Clean up state
      await env.SESSIONS.delete(`oauth_state:${state}`);

      // Check required environment variables
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        console.error("[auth/callback] missing GitHub OAuth credentials");
        return errorResponse(
          request,
          env,
          "Server configuration error: Missing GitHub credentials",
          500,
        );
      }

      // Exchange code for token
      const config: OAuthConfig = {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        redirectUri: env.GITHUB_REDIRECT_URI,
      };

      console.log("[auth/callback] exchanging code for token");
      const tokenResponse = await exchangeCodeForToken(code, config);
      console.log("[auth/callback] token received");
      const grantedScopes = parseGitHubScopeList(
        (tokenResponse as { scope?: unknown }).scope,
      );

      // Fetch user details
      console.log("[auth/callback] fetching user details");
      const user = await fetchGitHubUser(tokenResponse.access_token);
      console.log("[auth/callback] user fetched:", user.login);
      if (!hasPrivateAlphaAccess(user.login, env, { requestUrl: request.url })) {
        console.warn("[auth/callback] private-alpha access denied");
        return new Response(null, {
          status: 302,
          headers: {
            Location: getPrivateAlphaWaitlistUrl(env),
            ...getCorsHeaders(request, env),
          },
        });
      }
      const commitIdentityDefaults =
        await resolveGitHubProfileIdentityFromOAuth(
          tokenResponse.access_token,
          user,
        );

      // Encrypt token before storing
      const encryptedToken = await encryptToken(
        tokenResponse.access_token,
        env.GITHUB_TOKEN_ENCRYPTION_KEY,
      );

      const createdSession = await createGitHubOAuthSession(env, {
        providerAccountId: user.id.toString(),
        login: user.login,
        avatarUrl: user.avatar_url,
        email: commitIdentityDefaults.authorEmail,
        displayName: commitIdentityDefaults.authorName,
        accessToken: tokenResponse.access_token,
        encryptedToken,
        scopes: grantedScopes ?? [],
        tokenExpiresInSeconds: tokenResponse.expires_in ?? null,
      });

      const frontendUrl = env.FRONTEND_URL || "http://localhost:5173";
      console.log("[auth/callback] redirecting to frontend");

      const redirectUrl = new URL(frontendUrl);

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectUrl.toString(),
          "Set-Cookie": createSessionCookie(createdSession.sessionToken),
          ...getCorsHeaders(request, env),
        },
      });
    } catch (error) {
      console.error("[auth/callback] error:", error);
      const message =
        error instanceof Error ? error.message : "Authentication failed";
      return errorResponse(request, env, message, 500);
    }
  }

  /**
   * Get current user session
   * GET /auth/session
   */
  static async handleGetSession(request: Request, env: Env): Promise<Response> {
    try {
      const authenticatedSession = await getAuthenticatedUserSession(
        request,
        env,
      );
      if (!authenticatedSession) {
        return jsonResponse(request, env, { authenticated: false });
      }

      const commitIdentity = await readCommitIdentityStateForUser(
        env,
        authenticatedSession,
      );
      const { session } = authenticatedSession;

      return jsonResponse(request, env, {
        authenticated: true,
        user: {
          id: session.userId,
          login: session.login,
          avatar: session.avatar,
          email: session.email,
          name: session.name ?? null,
          githubScopes: session.githubScopes ?? [],
          commitIdentity,
        },
      });
    } catch (error) {
      console.error("[auth/session] error:", error);
      if (isSessionStoreUnavailableError(error)) {
        return errorResponse(
          request,
          env,
          "Session store is temporarily unavailable. Please retry.",
          503,
        );
      }
      return errorResponse(request, env, "Failed to get session", 500);
    }
  }

  /**
   * Logout user
   * POST /auth/logout
   */
  static async handleLogout(request: Request, env: Env): Promise<Response> {
    try {
      await revokeAuthenticatedSession(request, env);

      return jsonResponse(
        request,
        env,
        { success: true },
        {
          status: 200,
          customHeaders: {
            "Set-Cookie": createExpiredSessionCookie(),
          },
        },
      );
    } catch (error) {
      console.error("[auth/logout] error:", error);
      return errorResponse(request, env, "Logout failed", 500);
    }
  }
}
