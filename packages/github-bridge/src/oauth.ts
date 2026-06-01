/**
 * GitHub OAuth Flow Implementation
 *
 * This module handles the complete OAuth 2.0 flow for GitHub authentication,
 * including authorization URL generation, token exchange, and token refresh.
 */

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
}

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  email: string | null;
  name: string | null;
}

interface GitHubOAuthErrorResponse {
  error?: string;
  error_description?: string;
}

export const DEFAULT_SCOPES = ["repo", "read:user", "user:email"];

/**
 * Generate the GitHub OAuth authorization URL
 */
export function generateAuthUrl(config: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: (config.scopes || DEFAULT_SCOPES).join(" "),
    state,
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeCodeForToken(
  code: string,
  config: OAuthConfig,
): Promise<GitHubTokenResponse> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.statusText}`);
  }

  const data = await readJsonResponse(response);
  const errorResponse = readOAuthError(data);

  if (errorResponse.error) {
    throw new Error(
      `GitHub OAuth error: ${errorResponse.error_description || errorResponse.error}`,
    );
  }

  return readTokenResponse(data);
}

/**
 * Verify state parameter to prevent CSRF attacks
 */
export function verifyState(
  receivedState: string,
  expectedState: string,
): boolean {
  // Use timing-safe comparison to prevent timing attacks
  if (receivedState.length !== expectedState.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < receivedState.length; i++) {
    result |= receivedState.charCodeAt(i) ^ expectedState.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Generate a cryptographically secure state parameter
 */
export function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Fetch authenticated user details from GitHub
 */
export async function fetchGitHubUser(
  accessToken: string,
): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Shadowbox-GitHub-Bridge/0.1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user: ${response.statusText}`);
  }

  return readGitHubUser(await readJsonResponse(response));
}

async function readJsonResponse(response: Response): Promise<unknown> {
  return response.json();
}

function readOAuthError(payload: unknown): GitHubOAuthErrorResponse {
  if (!isRecord(payload)) {
    return {};
  }
  return {
    error: readOptionalString(payload.error),
    error_description: readOptionalString(payload.error_description),
  };
}

function readTokenResponse(payload: unknown): GitHubTokenResponse {
  if (!isRecord(payload)) {
    throw new Error("GitHub OAuth token response was not an object.");
  }
  const accessToken = readRequiredString(payload.access_token, "access_token");
  const tokenType = readRequiredString(payload.token_type, "token_type");
  const scope = readRequiredString(payload.scope, "scope");
  return {
    access_token: accessToken,
    token_type: tokenType,
    scope,
    refresh_token: readOptionalString(payload.refresh_token),
    expires_in: readOptionalNumber(payload.expires_in),
  };
}

function readGitHubUser(payload: unknown): GitHubUser {
  if (!isRecord(payload)) {
    throw new Error("GitHub user response was not an object.");
  }
  return {
    id: readRequiredNumber(payload.id, "id"),
    login: readRequiredString(payload.login, "login"),
    avatar_url: readRequiredString(payload.avatar_url, "avatar_url"),
    email: readNullableString(payload.email, "email"),
    name: readNullableString(payload.name, "name"),
  };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`GitHub response field "${field}" was not a string.`);
  }
  if (value.length === 0) {
    throw new Error(`GitHub response field "${field}" was empty.`);
  }
  return value;
}

function readRequiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`GitHub response field "${field}" was not a number.`);
  }
  return value;
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`GitHub response field "${field}" was not a string.`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
