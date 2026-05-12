import { gitBootstrapPath } from "./platform-endpoints.js";
import { z } from "zod";

export interface GitWorkspaceBootstrapRequest {
  runId: string;
  sessionId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryBranch?: string;
  repositoryBaseUrl?: string;
}

export interface GitWorkspaceBootstrapResponse {
  status: "ready" | "needs-auth" | "sync-failed" | "invalid-context";
  message?: string;
}

const GitWorkspaceBootstrapRequestSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  repositoryOwner: z.string().min(1),
  repositoryName: z.string().min(1),
  repositoryBranch: z.string().optional(),
  repositoryBaseUrl: z.string().url().optional(),
});

const GitWorkspaceBootstrapResponseSchema = z.object({
  status: z.enum(["ready", "needs-auth", "sync-failed", "invalid-context"]),
  message: z.string().optional(),
});

const ErrorPayloadSchema = z.object({
  error: z.string().optional(),
});

const bootstrapInFlight = new Map<
  string,
  Promise<GitWorkspaceBootstrapResponse>
>();

export async function bootstrapGitWorkspace(
  request: GitWorkspaceBootstrapRequest,
): Promise<GitWorkspaceBootstrapResponse> {
  const validatedRequest = GitWorkspaceBootstrapRequestSchema.parse(request);
  const requestKey = getBootstrapRequestKey(validatedRequest);

  const inFlight = bootstrapInFlight.get(requestKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = executeBootstrapRequest(validatedRequest);
  bootstrapInFlight.set(requestKey, promise);

  try {
    return await promise;
  } finally {
    if (bootstrapInFlight.get(requestKey) === promise) {
      bootstrapInFlight.delete(requestKey);
    }
  }
}

async function executeBootstrapRequest(
  request: GitWorkspaceBootstrapRequest,
): Promise<GitWorkspaceBootstrapResponse> {
  const response = await fetch(gitBootstrapPath(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(await extractBootstrapErrorMessage(response));
  }

  const payload = GitWorkspaceBootstrapResponseSchema.parse(await response.json());
  return payload;
}

async function extractBootstrapErrorMessage(response: Response): Promise<string> {
  let message = `Failed to bootstrap workspace: HTTP ${response.status}`;
  try {
    const payload = ErrorPayloadSchema.parse(await response.json());
    if (payload.error && payload.error.trim().length > 0) {
      message = payload.error;
    }
  } catch {
    // Keep HTTP fallback message.
  }
  return message;
}

function getBootstrapRequestKey(request: GitWorkspaceBootstrapRequest): string {
  return [
    request.sessionId.trim(),
    request.runId.trim(),
    request.repositoryOwner.trim(),
    request.repositoryName.trim(),
    request.repositoryBranch?.trim() ?? "",
    request.repositoryBaseUrl?.trim() ?? "",
  ].join(":");
}

export function _resetGitBootstrapInFlightForTests(): void {
  bootstrapInFlight.clear();
}
