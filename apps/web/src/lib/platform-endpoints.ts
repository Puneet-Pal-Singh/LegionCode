/**
 * Platform Endpoints - Centralized endpoint resolution for all API services
 * Removes hardcoded URLs and enforces environment-driven configuration
 * Provides type-safe path builders for all API routes
 */

import {
  findMissingEndpointEnvVars,
  formatMissingEndpointEnvMessage,
} from "./endpoint-config.js";

// Module-level cache for base URLs to avoid repeated warnings
let brainHttpBaseCache: string | undefined;
let muscleHttpBaseCache: string | undefined;
let muscleWsBaseCache: string | undefined;

/**
 * Reset endpoint cache (for testing only)
 * @internal
 */
export function _resetEndpointCache(): void {
  brainHttpBaseCache = undefined;
  muscleHttpBaseCache = undefined;
  muscleWsBaseCache = undefined;
}

/**
 * Strip trailing slashes from URL
 */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Get the Brain service base HTTP URL
 * Brain handles logic, prompt assembly, and tool selection
 * Default: http://localhost:8788 (dev only)
 */
export function getBrainHttpBase(): string {
  // Return cached value if available
  if (brainHttpBaseCache !== undefined) {
    return brainHttpBaseCache;
  }

  const url = import.meta.env.VITE_BRAIN_BASE_URL;
  if (url) {
    brainHttpBaseCache = stripTrailingSlash(url);
    return brainHttpBaseCache;
  }

  // Safe local default for development
  const defaultUrl = "http://localhost:8788";
  console.warn(
    "[platform-endpoints] VITE_BRAIN_BASE_URL not set, using default:",
    defaultUrl,
  );
  brainHttpBaseCache = defaultUrl;
  return brainHttpBaseCache;
}

/**
 * Get the Muscle service base HTTP URL
 * Muscle handles code execution, git operations, and filesystem
 * Default: http://localhost:8787 (dev only)
 */
export function getMuscleHttpBase(): string {
  // Return cached value if available
  if (muscleHttpBaseCache !== undefined) {
    return muscleHttpBaseCache;
  }

  const url = import.meta.env.VITE_MUSCLE_BASE_URL;
  if (url) {
    muscleHttpBaseCache = stripTrailingSlash(url);
    return muscleHttpBaseCache;
  }

  // Safe local default for development
  const defaultUrl = "http://localhost:8787";
  console.warn(
    "[platform-endpoints] VITE_MUSCLE_BASE_URL not set, using default:",
    defaultUrl,
  );
  muscleHttpBaseCache = defaultUrl;
  return muscleHttpBaseCache;
}

/**
 * Get the Muscle service base WebSocket URL
 * Used for real-time terminal sessions and streaming
 * Default: ws://localhost:8787 (dev only)
 */
export function getMuscleWsBase(): string {
  // Return cached value if available
  if (muscleWsBaseCache !== undefined) {
    return muscleWsBaseCache;
  }

  const url = import.meta.env.VITE_MUSCLE_WS_URL;
  if (url) {
    muscleWsBaseCache = stripTrailingSlash(url);
    return muscleWsBaseCache;
  }

  // Safe local default for development
  const defaultUrl = "ws://localhost:8787";
  console.warn(
    "[platform-endpoints] VITE_MUSCLE_WS_URL not set, using default:",
    defaultUrl,
  );
  muscleWsBaseCache = defaultUrl;
  return muscleWsBaseCache;
}

/**
 * Build the full chat stream endpoint URL
 * Used for streaming chat responses from Brain
 * Path: /chat
 */
export function chatStreamPath(): string {
  return `${getBrainHttpBase()}/chat`;
}

/**
 * Build the workflow events endpoint URL
 * Used for fetching canonical run events from Brain
 * Path: /api/run/events?runId=<runId>
 */
export function runEventsPath(runId: string): string {
  return `${getBrainHttpBase()}/api/run/events?runId=${encodeURIComponent(runId)}`;
}

/**
 * Build the live run events stream endpoint URL
 * Used for subscribing to canonical runtime events from Brain while a run is active
 * Path: /api/run/events/stream?runId=<runId>
 */
export function runEventsStreamPath(runId: string): string {
  return `${getBrainHttpBase()}/api/run/events/stream?runId=${encodeURIComponent(runId)}`;
}

/**
 * Build the activity feed endpoint URL
 * Used for fetching the structured activity feed snapshot from Brain
 * Path: /api/run/activity?runId=<runId>
 */
export function runActivityPath(runId: string): string {
  return `${getBrainHttpBase()}/api/run/activity?runId=${encodeURIComponent(runId)}`;
}

/**
 * Build the run approval decision endpoint URL.
 * Used for resolving pending approval requests from the composer approval dock.
 * Path: /api/run/approval
 */
export function runApprovalPath(): string {
  return `${getBrainHttpBase()}/api/run/approval`;
}

/**
 * Build the full chat history endpoint URL
 * Used for fetching canonical transcript messages from Brain
 * Path: /api/chat/history
 */
export function chatHistoryPath(runId: string): string {
  return `${getBrainHttpBase()}/api/chat/history/${encodeURIComponent(runId)}`;
}

/**
 * Build the canonical sessions endpoint URL
 * Used for hydrating and creating task/sidebar session roots from Brain
 * Path: /api/sessions
 */
export function sessionsPath(): string {
  return `${getBrainHttpBase()}/api/sessions`;
}

/**
 * Build the canonical git status endpoint URL through Brain.
 * Used for fetching current git status for a run-scoped workspace.
 * Path: /api/git/status?runId=<runId>&sessionId=<sessionId?>
 */
export function gitStatusPath(runId: string, sessionId?: string): string {
  const params = new URLSearchParams({
    runId,
  });

  if (sessionId) {
    params.set("sessionId", sessionId);
  }

  return `${getBrainHttpBase()}/api/git/status?${params.toString()}`;
}

/**
 * Build the canonical git diff endpoint URL through Brain.
 * Used for fetching a diff for a specific path within a run-scoped workspace.
 * Path: /api/git/diff?runId=<runId>&sessionId=<sessionId?>&path=<path>&staged=<staged?>
 */
export function gitDiffPath(options: {
  runId: string;
  sessionId?: string;
  path: string;
  staged?: boolean;
}): string {
  const params = new URLSearchParams({
    runId: options.runId,
    path: options.path,
  });

  if (options.sessionId) {
    params.set("sessionId", options.sessionId);
  }

  if (typeof options.staged === "boolean") {
    params.set("staged", String(options.staged));
  }

  return `${getBrainHttpBase()}/api/git/diff?${params.toString()}`;
}

/**
 * Build the full git stage/unstage endpoint URL
 * Used for staging/unstaging files via Brain (proxied to Muscle)
 *
 * Canonical endpoint: POST /api/git/stage with unified contract
 * Request body: { files: string[], unstage?: boolean }
 * - unstage: false (or omitted) = stage files
 * - unstage: true = unstage (restore) files
 *
 * Path: /api/git/stage
 */
export function gitStagePath(): string {
  return `${getBrainHttpBase()}/api/git/stage`;
}

/**
 * Build the canonical git commit endpoint URL through Brain.
 * Used for committing staged changes for a run-scoped workspace.
 * Path: /api/git/commit
 */
export function gitCommitPath(): string {
  return `${getBrainHttpBase()}/api/git/commit`;
}

/**
 * Build the canonical git branch endpoint URL through Brain.
 * Used for creating or switching to a branch for a run-scoped workspace.
 * Path: /api/git/branch
 */
export function gitBranchPath(): string {
  return `${getBrainHttpBase()}/api/git/branch`;
}

/**
 * Build the canonical git push endpoint URL through Brain.
 * Used for pushing a branch from a run-scoped workspace to its remote.
 * Path: /api/git/push
 */
export function gitPushPath(): string {
  return `${getBrainHttpBase()}/api/git/push`;
}

/**
 * Build the canonical git pull-request endpoint URL through Brain.
 * Used for creating a pull request from authoritative run/worktree state.
 * Path: /api/git/pull-request
 */
export function gitPullRequestPath(): string {
  return `${getBrainHttpBase()}/api/git/pull-request`;
}

/**
 * Build the git workspace bootstrap endpoint URL
 * Used to initialize run-scoped repository before first chat turn.
 *
 * Path: /api/git/bootstrap
 */
export function gitBootstrapPath(): string {
  return `${getBrainHttpBase()}/api/git/bootstrap`;
}

/**
 * Build the GitHub pull request endpoint URL through Brain.
 * Used for creating and listing pull requests via the authenticated GitHub session.
 * Path: /api/github/pulls
 */
export function githubPullsPath(): string {
  return `${getBrainHttpBase()}/api/github/pulls`;
}

/**
 * Build the artifact endpoint URL
 * Used for loading artifact content from Muscle
 * Path: /api/artifacts/:key
 */
export function artifactPath(runId: string, key: string): string {
  return `${getMuscleHttpBase()}/api/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(key)}`;
}

/**
 * Build the terminal WebSocket connection path
 * Used for establishing real-time terminal sessions
 * Path: /connect?session=<sessionId>
 */
export function terminalConnectPath(sessionId: string): string {
  const wsBase = getMuscleWsBase();
  return `${wsBase}/connect?session=${encodeURIComponent(sessionId)}`;
}

/**
 * Build the terminal command execution endpoint URL
 * Used for executing commands in terminal via HTTP
 * Path: /?session=<sessionId>
 */
export function terminalCommandPath(sessionId: string): string {
  return `${getMuscleHttpBase()}/?session=${encodeURIComponent(sessionId)}`;
}

/**
 * Validate all required environment variables at startup
 * Logs warnings for missing env vars (safe to run with defaults in dev)
 */
export function validateEndpointConfig(): void {
  const missingVars = findMissingEndpointEnvVars(
    import.meta.env as unknown as Record<string, string | undefined>,
  );

  if (missingVars.length > 0 && import.meta.env.MODE === "production") {
    throw new Error(formatMissingEndpointEnvMessage(missingVars));
  }

  if (missingVars.length > 0 && import.meta.env.MODE !== "production") {
    console.warn(
      "[platform-endpoints] Using default endpoints for missing env vars:",
      missingVars,
    );
  }
}
