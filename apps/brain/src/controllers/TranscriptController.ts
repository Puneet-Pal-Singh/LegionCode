import { z } from "zod";
import {
  RunIdSchema,
} from "@repo/platform-protocol";
import type {
  SessionRecord,
} from "@repo/persistence";
import { errorResponse, jsonResponse } from "../http/response";
import type { Env } from "../types/ai";
import {
  getAuthenticatedUserSession,
  isSessionStoreUnavailableError,
} from "../services/AuthService";
import { withRunRepository } from "../services/runs/RunPersistenceFactory";
import { withTranscriptRepository } from "../services/sessions/TranscriptPersistenceFactory";
import {
  readPersistedThreadTitleScope,
  ThreadTitleService,
} from "../services/thread-titles";

const SessionCreateRequestSchema = z.object({
  sessionId: z.string().uuid(),
  runId: RunIdSchema.optional(),
  workspaceId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  repository: z.string().trim().min(1).max(240).optional(),
  mode: z.string().trim().min(1).max(64).optional(),
});

const ArchiveSessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

const RenameSessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(80),
});

export class TranscriptController {
  static async listSessions(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const payload = await withTranscriptRepository(env, (repository) =>
        repository.listSessions(auth.userId),
      );
      return jsonResponse(request, env, payload);
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async createSession(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const body = SessionCreateRequestSchema.parse(await request.json());
      const session = await createPersistedSession(body, auth.userId, env);

      return jsonResponse(request, env, { session }, { status: 201 });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async renameSessionTitle(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { sessionId } = SessionParamsSchema.parse(
        readSessionParams(request.url),
      );
      const body = RenameSessionRequestSchema.parse(await request.json());
      const titleScope = await readPersistedThreadTitleScope(
        env,
        auth.userId,
        sessionId,
      );
      if (!titleScope) {
        return errorResponse(
          request,
          env,
          "This task has no canonical title scope yet.",
          409,
          "TITLE_SCOPE_UNAVAILABLE",
        );
      }
      const session = await new ThreadTitleService(env).rename({
        sessionId,
        threadId: titleScope.threadId,
        runId: titleScope.runId,
        workspaceId: titleScope.workspaceId,
        userId: auth.userId,
        firstMessageId: titleScope.firstMessageId,
        title: body.title,
      });

      if (!session) {
        return errorResponse(request, env, "Session not found", 404);
      }

      console.log(
        `[chat/title] updated sessionId=${sessionId} source=user titleLength=${body.title.length}`,
      );
      return jsonResponse(request, env, { session });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async pinSession(request: Request, env: Env): Promise<Response> {
    return sessionMutationResponse(
      request,
      env,
      "pin",
      (repository, userId, sessionId) =>
        repository.pinSession(userId, sessionId),
    );
  }

  static async unpinSession(request: Request, env: Env): Promise<Response> {
    return sessionMutationResponse(
      request,
      env,
      "unpin",
      (repository, userId, sessionId) =>
        repository.unpinSession(userId, sessionId),
    );
  }

  static async archiveSession(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { sessionId } = ArchiveSessionParamsSchema.parse(
        readSessionParams(request.url),
      );
      const session = await withTranscriptRepository(env, (repository) =>
        repository.archiveSession(auth.userId, sessionId),
      );

      if (!session) {
        return errorResponse(request, env, "Session not found", 404);
      }

      console.log(`[chat/archive] archived sessionId=${sessionId}`);
      return jsonResponse(request, env, { session });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async unarchiveSession(request: Request, env: Env): Promise<Response> {
    return sessionMutationResponse(
      request,
      env,
      "unarchive",
      (repository, userId, sessionId) =>
        repository.unarchiveSession(userId, sessionId),
    );
  }

  static async deleteArchivedSession(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }
      const { sessionId } = ArchiveSessionParamsSchema.parse(
        readSessionParams(request.url),
      );
      const deleted = await withTranscriptRepository(env, (repository) =>
        repository.deleteArchivedSession(auth.userId, sessionId),
      );
      if (!deleted) {
        return errorResponse(request, env, "Archived session not found", 404);
      }
      return jsonResponse(request, env, { deleted: true });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async listArchivedSessions(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const sessions = await withTranscriptRepository(env, (repository) =>
        repository.listArchivedSessions(auth.userId),
      );
      return jsonResponse(request, env, { sessions });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

}

async function createPersistedSession(
  body: z.infer<typeof SessionCreateRequestSchema>,
  userId: string,
  env: Env,
): Promise<SessionRecord> {
  const session = await ensureTranscriptSession(body, userId, env, null);
  if (!body.runId) {
    return session;
  }

  await ensureSessionRun(body, body.runId, userId, env);
  return await ensureTranscriptSession(body, userId, env, body.runId);
}

async function ensureTranscriptSession(
  body: z.infer<typeof SessionCreateRequestSchema>,
  userId: string,
  env: Env,
  activeRunId: string | null,
): Promise<SessionRecord> {
  return await withTranscriptRepository(env, (repository) =>
    repository.ensureSession({
      sessionId: body.sessionId,
      userId,
      workspaceId: body.workspaceId ?? null,
      title: body.title ?? "Untitled task",
      titleSource: "preview",
      repository: body.repository ?? null,
      activeRunId,
      mode: body.mode ?? "build",
      status: "idle",
    }),
  );
}

async function ensureSessionRun(
  body: z.infer<typeof SessionCreateRequestSchema>,
  runId: string,
  userId: string,
  env: Env,
): Promise<void> {
  await withRunRepository(env, async (repository) => {
    await repository.ensureRun({
      id: runId,
      userId,
      workspaceId: body.workspaceId ?? null,
      sessionId: body.sessionId,
      taskId: body.sessionId,
      status: "created",
      mode: body.mode ?? "build",
    });
  });
}


const SessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

type TranscriptRepositoryForMutation = Parameters<
  Parameters<typeof withTranscriptRepository>[1]
>[0];

async function sessionMutationResponse(
  request: Request,
  env: Env,
  operation: "pin" | "unpin" | "unarchive",
  mutate: (
    repository: TranscriptRepositoryForMutation,
    userId: string,
    sessionId: string,
  ) => Promise<SessionRecord | null>,
): Promise<Response> {
  try {
    const auth = await getAuthenticatedUserSession(request, env);
    if (!auth) {
      return errorResponse(request, env, "Unauthorized", 401);
    }

    const { sessionId } = SessionParamsSchema.parse(
      readSessionParams(request.url),
    );
    const session = await withTranscriptRepository(env, (repository) =>
      mutate(repository, auth.userId, sessionId),
    );

    if (!session) {
      return errorResponse(request, env, "Session not found", 404);
    }

    console.log(formatSessionMutationLog(operation, sessionId));
    return jsonResponse(request, env, { session });
  } catch (error) {
    return transcriptErrorResponse(request, env, error);
  }
}

function formatSessionMutationLog(
  operation: "pin" | "unpin" | "unarchive",
  sessionId: string,
): string {
  if (operation === "pin") {
    return `[chat/pin] pinned sessionId=${sessionId}`;
  }
  if (operation === "unpin") {
    return `[chat/pin] unpinned sessionId=${sessionId}`;
  }
  return `[chat/archive] unarchived sessionId=${sessionId}`;
}

function readSessionParams(url: string): { sessionId: string | null } {
  const match = new URL(url).pathname.match(
    /^\/api\/sessions\/([^/]+)(?:\/|$)/,
  );
  return { sessionId: match?.[1] ?? null };
}

function transcriptErrorResponse(
  request: Request,
  env: Env,
  error: unknown,
): Response {
  if (error instanceof z.ZodError) {
    console.warn("[transcript/request] invalid request", error.issues);
    return errorResponse(request, env, "Invalid transcript request", 400);
  }

  if (isSessionStoreUnavailableError(error)) {
    return errorResponse(request, env, error.message, 503);
  }

  console.error("[transcript/persistence] request failed:", error);
  return errorResponse(request, env, "Failed to load transcript state", 500);
}
