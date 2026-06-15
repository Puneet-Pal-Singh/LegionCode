import type {
  CommitPayload,
  CreateBranchPayload,
  CreatePullRequestFromRunPayload,
  DiffContent,
  GitCommitIdentityState,
  GitBranchMutationResult,
  GitMutationErrorCode,
  GitMutationErrorMetadata,
  GitPullRequestMutationResult,
  GitPushMutationResult,
  GitStatusResponse,
  PushPayload,
  StageFilesRequest,
} from "@repo/shared-types";
import { z } from "zod";
import {
  gitBranchPath,
  gitCommitPath,
  gitDiffPath,
  gitPullRequestPath,
  gitPushPath,
  gitStagePath,
  gitStatusPath,
} from "./platform-endpoints.js";
import { observeRuntimeBootId } from "./runtime-boot-monitor.js";

interface GitRequestContext {
  runId: string;
  sessionId?: string;
}

interface GitDiffRequestContext extends GitRequestContext {
  path: string;
  staged?: boolean;
}

interface GitCommitRequestContext extends GitRequestContext {
  payload: CommitPayload;
}

interface GitBranchRequestContext extends GitRequestContext {
  payload: CreateBranchPayload;
}

interface GitPushRequestContext extends GitRequestContext {
  payload: PushPayload;
}

interface GitPullRequestRequestContext extends GitRequestContext {
  payload: CreatePullRequestFromRunPayload;
}

interface GitStageRequestContext extends GitRequestContext, StageFilesRequest {}

export class GitMutationError extends Error {
  constructor(
    message: string,
    public readonly code?: GitMutationErrorCode,
    public readonly metadata?: GitMutationErrorMetadata,
  ) {
    super(message);
    this.name = "GitMutationError";
  }
}

const gitRequestContextSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});

const gitDiffRequestContextSchema = gitRequestContextSchema.extend({
  path: z.string().min(1),
  staged: z.boolean().optional(),
});

const commitPayloadSchema = z
  .object({
    message: z.string().min(1),
    files: z.array(z.string().min(1)),
    authorName: z.string().min(1).optional(),
    authorEmail: z.string().email().optional(),
  })
  .superRefine((value, ctx) => {
    const hasAuthorName = typeof value.authorName === "string";
    const hasAuthorEmail = typeof value.authorEmail === "string";
    if (hasAuthorName !== hasAuthorEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authorName and authorEmail must be provided together",
        path: hasAuthorName ? ["authorEmail"] : ["authorName"],
      });
    }
  });

const gitCommitRequestContextSchema = gitRequestContextSchema.extend({
  payload: commitPayloadSchema,
});

const createBranchPayloadSchema = z.object({
  branch: z.string().min(1),
});

const gitBranchRequestContextSchema = gitRequestContextSchema.extend({
  payload: createBranchPayloadSchema,
});

const pushPayloadSchema = z.object({
  branch: z.string().min(1),
  remote: z.string().min(1).optional(),
});

const gitPushRequestContextSchema = gitRequestContextSchema.extend({
  payload: pushPayloadSchema,
});

const createPullRequestFromRunPayloadSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  base: z.string().min(1).optional(),
});

const gitPullRequestRequestContextSchema = gitRequestContextSchema.extend({
  payload: createPullRequestFromRunPayloadSchema,
});

const gitStageRequestContextSchema = gitRequestContextSchema.extend({
  files: z.array(z.string().min(1)),
  unstage: z.boolean().optional(),
});

const fileStatusSchema = z.object({
  path: z.string(),
  status: z.enum(["modified", "added", "deleted", "renamed", "untracked"]),
  additions: z.number(),
  deletions: z.number(),
  isStaged: z.boolean(),
});

const gitCommitIdentitySchema = z.object({
  authorName: z.string(),
  authorEmail: z.string(),
  source: z.enum([
    "workspace_git_config",
    "github_profile",
    "user_input",
  ]),
  verified: z.boolean(),
});

const gitCommitIdentityStateSchema: z.ZodType<GitCommitIdentityState> = z.union(
  [
    z.object({
      state: z.literal("ready"),
      identity: gitCommitIdentitySchema,
    }),
    z.object({
      state: z.literal("requires_input"),
      reason: z.enum(["missing_identity", "missing_name", "missing_email"]),
      suggestedAuthorName: z.string(),
      suggestedAuthorEmail: z.string(),
    }),
  ],
);

const gitMutationErrorResponseSchema = z.object({
  error: z.string(),
  code: z.enum([
    "COMMIT_IDENTITY_REQUIRED",
    "COMMIT_IDENTITY_INCOMPLETE",
    "COMMIT_IDENTITY_WRITE_FAILED",
    "BRANCH_CREATION_FAILED",
    "PUSH_FAILED",
    "PR_CREATION_FAILED",
  ]),
  metadata: z
    .object({
      commitIdentity: gitCommitIdentityStateSchema.optional(),
    })
    .optional(),
});

const gitStatusReadySchema = z.object({
  files: z.array(fileStatusSchema),
  ahead: z.number(),
  behind: z.number(),
  branch: z.string(),
  repoIdentity: z.string().min(1).nullable().optional(),
  commitIdentity: gitCommitIdentitySchema.nullable().optional(),
  hasStaged: z.boolean(),
  hasUnstaged: z.boolean(),
  gitAvailable: z.literal(true),
});

const gitBranchMutationResultSchema = z.object({
  success: z.literal(true),
  branch: z.string().min(1),
});

const gitPushMutationResultSchema = z.object({
  success: z.literal(true),
  branch: z.string().min(1),
  remote: z.string().min(1),
});

const gitPullRequestMutationResultSchema = z.object({
  success: z.literal(true),
  pullRequest: z.object({
    number: z.number(),
    title: z.string(),
    url: z.string().url(),
    state: z.enum(["open", "closed"]),
    head: z.string(),
    base: z.string(),
  }),
});

const gitSoftErrorSchema = z.object({
  success: z.literal(false),
  error: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
});

const gitNotRepositorySchema = z.object({
  gitAvailable: z.literal(false).optional(),
  recoverableCode: z.literal("NOT_A_GIT_REPOSITORY").optional(),
});

export async function getGitStatus(
  context: GitRequestContext,
): Promise<GitStatusResponse> {
  const parsedContext = gitRequestContextSchema.parse(context);
  const response = await fetch(
    gitStatusPath(parsedContext.runId, parsedContext.sessionId),
  );

  if (!response.ok) {
    throw new Error(
      await readGitErrorResponse(
        response,
        `Failed to fetch git status: HTTP ${response.status}`,
      ),
    );
  }

  observeRuntimeBootId(response.headers.get("X-Shadowbox-Runtime-Boot-Id"));
  const payload = (await response.json()) as unknown;
  return normalizeGitStatusResponse(payload);
}

export async function getGitDiff(
  context: GitDiffRequestContext,
): Promise<DiffContent> {
  const parsedContext = gitDiffRequestContextSchema.parse(context);
  const response = await fetch(
    gitDiffPath({
      runId: parsedContext.runId,
      sessionId: parsedContext.sessionId,
      path: parsedContext.path,
      staged: parsedContext.staged,
    }),
  );

  if (!response.ok) {
    throw new Error(
      await readGitErrorResponse(
        response,
        `Failed to fetch diff: HTTP ${response.status}`,
      ),
    );
  }

  return (await response.json()) as DiffContent;
}

export async function stageGitFiles(
  context: GitStageRequestContext,
): Promise<void> {
  const parsedContext = gitStageRequestContextSchema.parse(context);
  const response = await fetch(gitStagePath(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: parsedContext.runId,
      sessionId: parsedContext.sessionId,
      files: parsedContext.files,
      unstage: parsedContext.unstage ?? false,
    }),
  });

  if (!response.ok) {
    throw new Error(
      await readGitErrorResponse(
        response,
        `Failed to update staged files: HTTP ${response.status}`,
      ),
    );
  }
}

export async function commitGitChanges(
  context: GitCommitRequestContext,
): Promise<void> {
  const parsedContext = gitCommitRequestContextSchema.parse(context);
  const response = await fetch(gitCommitPath(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...parsedContext.payload,
      runId: parsedContext.runId,
      sessionId: parsedContext.sessionId,
    }),
  });

  if (!response.ok) {
    throw await readGitError(
      response,
      `Failed to commit changes: HTTP ${response.status}`,
    );
  }
}

export async function createGitBranch(
  context: GitBranchRequestContext,
): Promise<GitBranchMutationResult> {
  const parsedContext = gitBranchRequestContextSchema.parse(context);
  const response = await fetch(gitBranchPath(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: parsedContext.runId,
      sessionId: parsedContext.sessionId,
      branch: parsedContext.payload.branch,
    }),
  });

  if (!response.ok) {
    throw await readGitError(
      response,
      `Failed to create branch: HTTP ${response.status}`,
    );
  }

  return gitBranchMutationResultSchema.parse(
    (await response.json()) as unknown,
  );
}

export async function pushGitBranch(
  context: GitPushRequestContext,
): Promise<GitPushMutationResult> {
  const parsedContext = gitPushRequestContextSchema.parse(context);
  const response = await fetch(gitPushPath(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: parsedContext.runId,
      sessionId: parsedContext.sessionId,
      branch: parsedContext.payload.branch,
      remote: parsedContext.payload.remote,
    }),
  });

  if (!response.ok) {
    throw await readGitError(
      response,
      `Failed to push branch: HTTP ${response.status}`,
    );
  }

  return gitPushMutationResultSchema.parse((await response.json()) as unknown);
}

export async function createGitPullRequest(
  context: GitPullRequestRequestContext,
): Promise<GitPullRequestMutationResult> {
  const parsedContext = gitPullRequestRequestContextSchema.parse(context);
  const response = await fetch(gitPullRequestPath(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: parsedContext.runId,
      sessionId: parsedContext.sessionId,
      owner: parsedContext.payload.owner,
      repo: parsedContext.payload.repo,
      title: parsedContext.payload.title,
      body: parsedContext.payload.body,
      base: parsedContext.payload.base,
    }),
  });

  if (!response.ok) {
    throw await readGitError(
      response,
      `Failed to create pull request: HTTP ${response.status}`,
    );
  }

  return gitPullRequestMutationResultSchema.parse(
    (await response.json()) as unknown,
  );
}

async function readGitErrorResponse(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  try {
    const payload = (await response.json()) as unknown;
    return readGitErrorMessage(payload, fallbackMessage);
  } catch {
    return fallbackMessage;
  }
}

function readGitErrorMessage(
  payload: unknown,
  fallbackMessage: string,
): string {
  if (!payload || typeof payload !== "object") {
    return fallbackMessage;
  }

  const candidate = payload as {
    error?: unknown;
    message?: unknown;
    code?: unknown;
  };

  if (typeof candidate.error === "string" && candidate.error.trim()) {
    return candidate.error;
  }

  if (typeof candidate.message === "string" && candidate.message.trim()) {
    return candidate.message;
  }

  if (typeof candidate.code === "string" && candidate.code.trim()) {
    return candidate.code;
  }

  return fallbackMessage;
}

async function readGitError(
  response: Response,
  fallbackMessage: string,
): Promise<Error> {
  try {
    const payload = (await response.json()) as unknown;
    const parsedPayload = gitMutationErrorResponseSchema.safeParse(payload);
    if (parsedPayload.success) {
      return new GitMutationError(
        parsedPayload.data.error,
        parsedPayload.data.code,
        parsedPayload.data.metadata,
      );
    }
    return new Error(readGitErrorMessage(payload, fallbackMessage));
  } catch (error) {
    console.warn("[git-client] Failed to parse git error payload", error);
    return new Error(fallbackMessage);
  }
}

function normalizeGitStatusResponse(payload: unknown): GitStatusResponse {
  const softError = gitSoftErrorSchema.safeParse(payload);
  if (softError.success) {
    const errorMessage =
      softError.data.error ?? softError.data.message ?? softError.data.code;
    if (errorMessage?.includes("not a git repository")) {
      return getNotGitRepositoryStatus();
    }
    throw new Error(errorMessage ?? "Invalid git status response");
  }

  if (gitNotRepositorySchema.safeParse(payload).success) {
    return getNotGitRepositoryStatus();
  }

  const parsedStatus = gitStatusReadySchema.safeParse(payload);
  if (!parsedStatus.success) {
    throw new Error(
      `Invalid git status response: ${parsedStatus.error.issues[0]?.message ?? "missing fields"}`,
    );
  }

  return parsedStatus.data;
}

function getNotGitRepositoryStatus(): GitStatusResponse {
  return {
    files: [],
    ahead: 0,
    behind: 0,
    branch: "",
    repoIdentity: null,
    hasStaged: false,
    hasUnstaged: false,
    gitAvailable: false,
    recoverableCode: "NOT_A_GIT_REPOSITORY",
  };
}
