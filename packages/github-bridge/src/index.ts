/**
 * GitHub Bridge - Main Export Module
 *
 * This package provides a clean abstraction for GitHub OAuth and API operations,
 * designed to work across the LegionCode Control Plane (Brain) and Data Plane (Muscle).
 */

// OAuth Flow
export {
  generateAuthUrl,
  exchangeCodeForToken,
  verifyState,
  generateState,
  fetchGitHubUser,
  DEFAULT_SCOPES,
  type OAuthConfig,
  type GitHubTokenResponse,
  type GitHubUser,
} from "./oauth.js";

// API Client
export {
  GitHubAPIClient,
  type GitHubEmail,
  type Repository,
  type Branch,
  type FileContent,
  type PullRequest,
  type CreatePullRequestParams,
} from "./api.js";

// Token Management Utilities
export {
  encryptToken,
  decryptToken,
  generateSecureToken,
  type EncryptedToken,
} from "./crypto.js";
